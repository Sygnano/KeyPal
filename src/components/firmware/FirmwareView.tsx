import { FirmwareMain } from "./FirmwareMain";
import { BasicSidebar, FirmwareSidebar } from "./FirmwareSidebar";
import { useFwMode } from "./Preflight";

/** Firmware mode, loaded when first opened (the code editor is most of the app's size). */
export default function FirmwareView() {
  // Basic has no projects to list, but it keeps the sidebar: the switch back to the profiles and
  // to Advanced mode lives at the bottom of it.
  const mode = useFwMode();
  return (
    <>
      {mode === "advanced" ? <FirmwareSidebar /> : <BasicSidebar />}
      <FirmwareMain mode={mode} />
    </>
  );
}
