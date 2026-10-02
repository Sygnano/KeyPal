//! Which keyboards are plugged in, in normal mode or in their bootloader (ready to flash), and
//! whether Windows has a driver for the bootloader. Bootloaders aren't HID devices, so this lists
//! USB devices through SetupAPI rather than hidapi.

use serde::Serialize;

pub const KEYCHRON_VID: u16 = 0x3434;

/// The bootloaders Keychron's boards use (`bootloader` in their keyboard.json, 2025q3: 99 stm32-dfu,
/// 11 wb32-dfu, 7 at32-dfu, 1 atmel-dfu), as QMK's `platforms/chibios/bootloader.mk` lists them.
pub const BOOTLOADERS: &[(u16, u16, &str)] = &[
    (0x0483, 0xDF11, "STM32 DFU"),
    (0x2E3C, 0xDF11, "AT32 DFU"),
    (0x342D, 0xDFA0, "WB32 DFU"),
    (0x314B, 0x0106, "APM32 DFU"),
    (0x03EB, 0x2FF4, "Atmel DFU (ATmega32U4)"),
    (0x03EB, 0x2FF3, "Atmel DFU (ATmega16U4)"),
];

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DeviceKind {
    /// A Keychron keyboard running its firmware.
    Keyboard,
    /// A device in bootloader (DFU) mode.
    Bootloader,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UsbDevice {
    pub vid: u16,
    pub pid: u16,
    pub kind: DeviceKind,
    /// The bootloader's name, for kind `Bootloader`.
    pub bootloader: Option<String>,
    /// The Windows driver service bound to it ("WinUSB"…), None without a driver.
    pub driver: Option<String>,
    pub description: String,
    /// Windows' device instance id ("USB\VID_2E3C&PID_DF11\5&1234ABCD&0&2"). Unique per plugged-in
    /// device, so two devices with the same USB id are told apart — which is how the app refuses to
    /// flash when more than one bootloader is present.
    pub instance: String,
}

/// "USB\\VID_2E3C&PID_DF11&REV_0100" → (0x2E3C, 0xDF11). None for an interface of a composite
/// device ("&MI_01"): the device itself is listed too.
pub fn parse_hardware_id(id: &str) -> Option<(u16, u16)> {
    let up = id.to_ascii_uppercase();
    if up.contains("&MI_") {
        return None;
    }
    let hex = |key: &str| {
        let at = up.find(key)? + key.len();
        u16::from_str_radix(up.get(at..at + 4)?, 16).ok()
    };
    Some((hex("VID_")?, hex("PID_")?))
}

/// Keychron keyboards and known bootloaders among the given devices.
pub fn classify(vid: u16, pid: u16, driver: Option<String>, description: String, instance: String) -> Option<UsbDevice> {
    if vid == KEYCHRON_VID {
        return Some(UsbDevice { vid, pid, kind: DeviceKind::Keyboard, bootloader: None, driver, description, instance });
    }
    let (_, _, name) = BOOTLOADERS.iter().find(|b| b.0 == vid && b.1 == pid)?;
    Some(UsbDevice { vid, pid, kind: DeviceKind::Bootloader, bootloader: Some(name.to_string()), driver, description, instance })
}

/// Keychron keyboards and bootloaders plugged in now.
pub fn scan() -> Vec<UsbDevice> {
    #[cfg(windows)]
    {
        win::scan()
    }
    #[cfg(not(windows))]
    {
        vec![]
    }
}

#[cfg(windows)]
mod win {
    use super::{classify, parse_hardware_id, UsbDevice};
    use windows::core::w;
    use windows::Win32::Devices::DeviceAndDriverInstallation::{
        SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW, SetupDiGetDeviceInstanceIdW,
        SetupDiGetDeviceRegistryPropertyW, DIGCF_ALLCLASSES, DIGCF_PRESENT, SETUP_DI_REGISTRY_PROPERTY, SPDRP_DEVICEDESC, SPDRP_HARDWAREID,
        SPDRP_SERVICE, SP_DEVINFO_DATA,
    };
    use windows::Win32::Foundation::HWND;

    /// A string or multi-string property, as separate strings.
    ///
    /// # Safety
    /// `set` and `dev` must come from a live `SetupDiGetClassDevsW`/`SetupDiEnumDeviceInfo` pair.
    unsafe fn property(
        set: windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO,
        dev: &SP_DEVINFO_DATA,
        prop: SETUP_DI_REGISTRY_PROPERTY,
    ) -> Vec<String> {
        let mut buf = vec![0u8; 2048];
        let mut size = 0u32;
        if SetupDiGetDeviceRegistryPropertyW(set, dev, prop, None, Some(&mut buf), Some(&mut size)).is_err() {
            return vec![];
        }
        let words: Vec<u16> = buf[..size as usize].as_chunks::<2>().0.iter().map(|c| u16::from_le_bytes(*c)).collect();
        words.split(|&w| w == 0).filter(|s| !s.is_empty()).map(String::from_utf16_lossy).collect()
    }

    /// Windows' device instance id: unique per device plugged in, unlike the hardware id.
    ///
    /// # Safety
    /// `set` and `dev` must come from a live `SetupDiGetClassDevsW`/`SetupDiEnumDeviceInfo` pair.
    unsafe fn instance_id(set: windows::Win32::Devices::DeviceAndDriverInstallation::HDEVINFO, dev: &SP_DEVINFO_DATA) -> String {
        let mut buf = [0u16; 512];
        let mut size = 0u32;
        if SetupDiGetDeviceInstanceIdW(set, dev, Some(&mut buf), Some(&mut size)).is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..(size as usize).saturating_sub(1).min(buf.len())])
    }

    pub fn scan() -> Vec<UsbDevice> {
        let mut out = vec![];
        // SAFETY: the device-info set is created here and destroyed at the end of the block; every
        // `dev` passed to the helpers below comes from `SetupDiEnumDeviceInfo` on that same set.
        unsafe {
            let Ok(set) = SetupDiGetClassDevsW(None, w!("USB"), Some(HWND::default()), DIGCF_PRESENT | DIGCF_ALLCLASSES) else {
                return out;
            };
            let mut i = 0;
            loop {
                let mut dev = SP_DEVINFO_DATA { cbSize: std::mem::size_of::<SP_DEVINFO_DATA>() as u32, ..Default::default() };
                if SetupDiEnumDeviceInfo(set, i, &mut dev).is_err() {
                    break;
                }
                i += 1;
                let Some((vid, pid)) = property(set, &dev, SPDRP_HARDWAREID).iter().find_map(|id| parse_hardware_id(id)) else {
                    continue;
                };
                let driver = property(set, &dev, SPDRP_SERVICE).into_iter().next();
                let description = property(set, &dev, SPDRP_DEVICEDESC).into_iter().next().unwrap_or_default();
                let instance = instance_id(set, &dev);
                if let Some(d) = classify(vid, pid, driver, description, instance) {
                    if !out.contains(&d) {
                        out.push(d);
                    }
                }
            }
            let _ = SetupDiDestroyDeviceInfoList(set);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hardware_ids() {
        assert_eq!(parse_hardware_id("USB\\VID_2E3C&PID_DF11&REV_0200"), Some((0x2E3C, 0xDF11)));
        assert_eq!(parse_hardware_id("USB\\VID_3434&PID_0F61"), Some((0x3434, 0x0F61)));
        assert_eq!(parse_hardware_id("USB\\VID_3434&PID_0F61&MI_02"), None, "an interface, not the device");
        assert_eq!(parse_hardware_id("USB\\ROOT_HUB30"), None);
    }

    #[test]
    fn classifies_keyboards_and_bootloaders() {
        let kb = classify(0x3434, 0x0F61, Some("usbccgp".into()), "Composite".into(), r"USB\VID_3434&PID_0F61\1".into()).unwrap();
        assert_eq!(kb.kind, DeviceKind::Keyboard);
        let at32 = classify(0x2E3C, 0xDF11, None, "AT32".into(), r"USB\VID_2E3C&PID_DF11\2".into()).unwrap();
        assert_eq!((at32.kind, at32.bootloader.as_deref(), at32.driver.as_deref()), (DeviceKind::Bootloader, Some("AT32 DFU"), None));
        assert!(classify(0x046D, 0xC52B, None, "a mouse".into(), String::new()).is_none());
    }

    #[test]
    fn scanning_does_not_fail() {
        // On the development PC the V6 8K is plugged in: it shows as a keyboard, no bootloader.
        let found = scan();
        assert!(found.iter().all(|d| matches!(d.kind, DeviceKind::Keyboard | DeviceKind::Bootloader)));
    }
}
