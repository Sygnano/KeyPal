/* SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Profile switcher for Keychron keyboards (KBoard Companion, the app): a RAM-only remap/macro
 * overlay driven over Raw HID.
 * The app's side of the protocol: src-tauri/src/protocol.rs in https://github.com/Sygnano/kboard-companion.
 *
 * Add to your keymap folder, then in its rules.mk:
 *     VIA_ENABLE = yes
 *     DEFERRED_EXEC_ENABLE = yes
 *     SRC += profile_switcher.c
 *
 * It uses no *_user hook, so it can't clash with your keymap.c:
 *   - via_custom_value_command_kb   channel 0 carries the protocol (Keychron leaves it free)
 *   - keymap_key_to_keycode         the overlay: remaps on any of the keymap's layers
 *   - pre_process_record_kb         macro keys (QK_USER + i), key presses for "light on
 *                                   keypress" colours, key reports for the app's keyboard
 *                                   tester; chains to pre_process_record_user
 *   - rgb_matrix_indicators_advanced_kb  per-key colours (still or animated) over any effect,
 *                                   and keeping the app's colour/speed when Keychron reloads
 *                                   them; chains to _user
 *   - led_matrix_indicators_advanced_kb  the same on white backlights: per-key brightness
 *   - deferred exec                 macro playback, the swap once no key is held, sending
 *                                   key reports (raw_hid_send, never from a record hook)
 *
 * A few boards define the indicators _kb hook themselves (C1 Pro, Q1 v1, Q9, Q9 Plus, Q11, S1).
 * For them add `OPT_DEFS += -DPS_INDICATORS_USER` to rules.mk: the module then takes the _user hook
 * (which their _kb calls first), so the keymap must not define that one.
 * Nothing is ever written to EEPROM: after a replug the keyboard has its own keymap again, and the
 * app sends the profile back.
 */

#include QMK_KEYBOARD_H
#include "via.h"
#include "deferred_exec.h"
#include "keymap_introspection.h"
#include "dynamic_keymap.h"
#include "raw_hid.h"

#ifndef VIA_ENABLE
#    error "profile_switcher.c needs VIA_ENABLE = yes in rules.mk"
#endif
#ifndef DEFERRED_EXEC_ENABLE
#    error "profile_switcher.c needs DEFERRED_EXEC_ENABLE = yes in rules.mk"
#endif

/* The protocol this module speaks. The app talks only to its own version, so
 * any change to a command, a reply or a packet layout takes a new number. 1 is the protocol of the
 * app's 1.0: the numbers used before it (2-9, development builds) were retired with it. */
#define PS_PROTO_VERSION 1
/* Which firmware the app built this from: it sets `OPT_DEFS += -DPS_BUILD_ID=0x…` from the
 * project's id, reads it back in STATUS and so knows what is on the keyboard. 0 when the module
 * was built by hand (QMK MSYS, a keymap of your own): the app then falls back to what the user
 * tells it. */
#ifndef PS_BUILD_ID
#    define PS_BUILD_ID 0
#endif
/* Layers the overlay covers: all of VIA's (4 unless the board says otherwise), at most 8. Each
 * takes about 0.5 KB of RAM (a live and a staged copy). Override in config.h. */
#ifndef PS_LAYERS
#    if defined(DYNAMIC_KEYMAP_LAYER_COUNT) && DYNAMIC_KEYMAP_LAYER_COUNT <= 8
#        define PS_LAYERS DYNAMIC_KEYMAP_LAYER_COUNT
#    elif defined(DYNAMIC_KEYMAP_LAYER_COUNT)
#        define PS_LAYERS 8
#    else
#        define PS_LAYERS 4
#    endif
#endif
_Static_assert(PS_LAYERS >= 1 && PS_LAYERS <= 32, "PS_LAYERS must be 1-32");
/* Must match MACRO_BUFFER_SIZE / MAX_MACROS in the app (protocol.rs, limits.ts). */
#define PS_MACRO_BUFFER_SIZE 2048
#define PS_MAX_MACROS 64
/* Keys a macro may have down at once that it hasn't released yet: released when it ends or is cut
 * short (another macro key, a new profile). A key past this many would stay down. 2 bytes each. */
#define PS_MAX_HELD 16
/* How long a macro "tap" holds its key. QMK's tap_code16 releases in the same instant (0.125 ms
 * apart on this 8 kHz board), which games that sample key state once per frame never see.
 * Override in config.h; 1 ms minimum. */
#ifndef PS_TAP_HOLD_MS
#    define PS_TAP_HOLD_MS 10
#endif
_Static_assert(PS_TAP_HOLD_MS >= 1, "PS_TAP_HOLD_MS must be at least 1");
/* Steps played in one go before yielding to the keyboard's main loop. */
#define PS_STEPS_PER_SLICE 16
#define PS_IDLE_POLL_MS 5

/* Key reports: the first byte of the unsolicited report, unused by VIA (0x01-0x15,
 * 0xFF), by Keychron (0xA0-0xAB) and by this module's replies (0x07/0x08 echoes). */
#define PS_KEY_REPORT_ID 0xE5
/* Reporting stops by itself when the app hasn't renewed it for this long (it renews every 2 s),
 * so an app that crashed or closed doesn't leave the keyboard sending. */
#ifndef PS_KEY_REPORT_TIMEOUT_MS
#    define PS_KEY_REPORT_TIMEOUT_MS 5000
#endif
/* Events waiting to be sent; more are dropped (and counted), never waited for. */
#define PS_KEY_QUEUE 32
/* row, col, state: 9 per 32-byte report after the 3-byte header. */
#define PS_KEYS_PER_REPORT 9
/* One report per tick at most: raw_hid_send waits (up to 100 ms) when the endpoint's queue is
 * full, so it is never called from the key-event hook and never more often than this. */
#define PS_KEY_FLUSH_MS 2

/* NUM_ENCODERS is a C expression on this board (counted from ENCODER_A_PINS), not a preprocessor
 * number, so it can size arrays but not be tested with #if. */
#ifdef ENCODER_MAP_ENABLE
#    define PS_HAS_ENCODERS
#endif

/* Per-key lighting: colours on an RGB matrix, brightness on a white LED matrix. */
#if defined(RGB_MATRIX_ENABLE)
#    define PS_LED_COUNT RGB_MATRIX_LED_COUNT
#elif defined(LED_MATRIX_ENABLE)
#    define PS_LED_COUNT LED_MATRIX_LED_COUNT
/* HSV, for the animations: rgb_matrix.h brings it in, led_matrix.h doesn't. */
#    include "color.h"
#endif

/* 0x02 and 0x03 are reserved: development builds before 1.0 used them for remaps on the default
 * layer only (LAYER_KEYS / LAYER_ENCODERS with PS_DEFAULT_LAYER do that now). */
enum {
    PS_BEGIN      = 0x01,
    PS_MACRO_DATA = 0x04,
    PS_COMMIT     = 0x05,
    PS_RGB_BEGIN  = 0x06,
    PS_RGB_KEYS   = 0x07,
    PS_RGB_COMMIT = 0x08,
    PS_LIGHTING   = 0x09,
    PS_LAYER_KEYS = 0x0A,
    PS_LAYER_ENCODERS = 0x0B,
    PS_RGB_KEYS_ANIM = 0x0C,
    PS_KEY_REPORT = 0x0D,
    PS_BOOTLOADER = 0x0E,
    PS_STATUS     = 0x10,
};
/* LAYER_KEYS / LAYER_ENCODERS: this layer number means "the current default layer". */
#define PS_DEFAULT_LAYER 0xFF

enum { OP_END = 0x00, OP_TAP = 0x01, OP_PRESS = 0x02, OP_RELEASE = 0x03, OP_DELAY = 0x04, OP_GAP = 0x05 };

/* The remaps of one keymap layer. */
typedef struct {
    uint16_t keys[MATRIX_ROWS][MATRIX_COLS];
#ifdef PS_HAS_ENCODERS
    uint16_t encoders[NUM_ENCODERS][2]; /* [index][clockwise] */
#endif
} ps_layer_t;

typedef struct {
    ps_layer_t layer[PS_LAYERS];
    uint8_t    macros[PS_MACRO_BUFFER_SIZE];
    uint16_t   macro_len;
    uint16_t   tag;
} ps_profile_t;

/* KC_TRNS everywhere: "keep the firmware keymap". Zero would mean KC_NO. */
#ifdef PS_HAS_ENCODERS
#    define PS_EMPTY_LAYER                                                                                     \
        {.keys = {[0 ... MATRIX_ROWS - 1] = {[0 ... MATRIX_COLS - 1] = KC_TRNS}},                                \
         .encoders = {[0 ... NUM_ENCODERS - 1] = {KC_TRNS, KC_TRNS}}}
#else
#    define PS_EMPTY_LAYER {.keys = {[0 ... MATRIX_ROWS - 1] = {[0 ... MATRIX_COLS - 1] = KC_TRNS}}}
#endif
#define PS_EMPTY_PROFILE {.layer = {[0 ... PS_LAYERS - 1] = PS_EMPTY_LAYER}}

static ps_profile_t active = PS_EMPTY_PROFILE;
static ps_profile_t staged = PS_EMPTY_PROFILE;
static bool         swap_pending;
static deferred_token swap_token = INVALID_DEFERRED_TOKEN;

/* Offsets of each macro in active.macros, rebuilt on every swap. */
static uint16_t macro_start[PS_MAX_MACROS];
static uint8_t  macro_count;

#ifdef RGB_MATRIX_ENABLE
/* Lighting the app asked for, re-applied over Keychron's reload (see lighting_keep). */
static struct {
    bool    on;
    uint8_t h, s, v, speed;
} want;
#endif

static struct {
    deferred_token token;
    uint16_t       pos;
    uint16_t       tapped; /* key of the tap in progress, released on the next slice (0 = none) */
    uint16_t       gap;    /* ms to wait after each key step (OP_GAP), unless a delay comes next */
    uint16_t       held[PS_MAX_HELD];
    uint8_t        held_count;
} play = {.token = INVALID_DEFERRED_TOKEN};

/* ------------------------------------------------------------------ macro playback */

static void hold(uint16_t kc) {
    for (uint8_t i = 0; i < play.held_count; i++) {
        if (play.held[i] == kc) return;
    }
    if (play.held_count < PS_MAX_HELD) play.held[play.held_count++] = kc;
}

static void unhold(uint16_t kc) {
    for (uint8_t i = 0; i < play.held_count; i++) {
        if (play.held[i] == kc) {
            play.held[i] = play.held[--play.held_count];
            return;
        }
    }
}

static void release_held(void) {
    if (play.tapped) {
        unregister_code16(play.tapped);
        play.tapped = 0;
    }
    while (play.held_count) unregister_code16(play.held[--play.held_count]);
}

/* The gap applies between key steps: not before the end, nor where an explicit delay replaces it. */
static bool gap_next(void) {
    if (!play.gap || play.pos + 3 > active.macro_len) return false;
    uint8_t op = active.macros[play.pos];
    return op == OP_TAP || op == OP_PRESS || op == OP_RELEASE;
}

static uint32_t play_slice(uint32_t trigger_time, void *cb_arg) {
    if (play.tapped) {
        unregister_code16(play.tapped);
        play.tapped = 0;
        if (gap_next()) return play.gap;
    }
    for (uint8_t n = 0; n < PS_STEPS_PER_SLICE; n++) {
        if (play.pos + 3 > active.macro_len || active.macros[play.pos] == OP_END) break;
        uint8_t  op  = active.macros[play.pos];
        uint16_t arg = (uint16_t)active.macros[play.pos + 1] << 8 | active.macros[play.pos + 2];
        play.pos += 3;
        switch (op) {
            case OP_TAP:
                register_code16(arg);
                play.tapped = arg;
                return PS_TAP_HOLD_MS; /* released at the top of the next slice */
            case OP_PRESS:
                register_code16(arg);
                hold(arg);
                if (gap_next()) return play.gap;
                break;
            case OP_RELEASE:
                unregister_code16(arg);
                unhold(arg);
                if (gap_next()) return play.gap;
                break;
            case OP_DELAY:
                if (arg) return arg;
                break;
            case OP_GAP:
                play.gap = arg;
                break;
            default: /* corrupt data: stop */
                play.pos = active.macro_len;
                break;
        }
    }
    if (play.pos + 3 > active.macro_len || active.macros[play.pos] == OP_END) {
        release_held();
        play.token = INVALID_DEFERRED_TOKEN;
        return 0;
    }
    return 1; /* more steps without a delay: continue on the next tick */
}

static void stop_macro(void) {
    if (play.token != INVALID_DEFERRED_TOKEN) {
        cancel_deferred_exec(play.token);
        play.token = INVALID_DEFERRED_TOKEN;
    }
    release_held();
}

static void start_macro(uint8_t slot) {
    stop_macro();
    if (slot >= macro_count) return;
    play.pos   = macro_start[slot];
    play.gap   = 0; /* until the macro's own OP_GAP */
    play.token = defer_exec(1, play_slice, NULL);
}

/* The layer QMK took this key's keycode from. get_event_keycode fills the source-layer cache on the
 * press (before pre_process_record_kb runs) and reads it back on the release; without the cache it
 * resolves the layer each time. */
static uint8_t source_layer(keypos_t key) {
#if !defined(NO_ACTION_LAYER) && !defined(STRICT_LAYER_RELEASE)
    if (!disable_action_cache) return read_source_layers_cache(key);
#endif
    return layer_switch_get_layer(key);
}

/* Whether `keycode` at this position comes from the overlay of the layer it was read from. QK_USER
 * is also where a keymap's own custom keycodes start (SAFE_RANGE), so the value alone doesn't make it
 * one of our macros, nor does a macro of ours at the same key on another layer. */
static bool from_overlay(keypos_t key, uint16_t keycode) {
    uint8_t l = source_layer(key);
    if (l >= PS_LAYERS) return false;
    const ps_layer_t *m = &active.layer[l];
    if (key.row < MATRIX_ROWS && key.col < MATRIX_COLS) return m->keys[key.row][key.col] == keycode;
#ifdef PS_HAS_ENCODERS
    if (key.row == KEYLOC_ENCODER_CW && key.col < NUM_ENCODERS) return m->encoders[key.col][1] == keycode;
    if (key.row == KEYLOC_ENCODER_CCW && key.col < NUM_ENCODERS) return m->encoders[key.col][0] == keycode;
#endif
    return false;
}

/* ------------------------------------------------------------------ key reports */

/* While the app's keyboard tester is open, every key event goes to it as it happens on the
 * matrix (before any remap): Fn keys, keys the profile remaps, knob turns (rows
 * KEYLOC_ENCODER_CW / _CCW, column = the knob). RAM only, off after a reset. */
static struct {
    bool           on;
    uint32_t       renewed;
    deferred_token token;
    uint8_t        head, count;
    uint8_t        dropped; /* events lost to a full queue since the last report (saturates) */
    struct {
        uint8_t row, col, pressed;
    } queue[PS_KEY_QUEUE];
} keys_out = {.token = INVALID_DEFERRED_TOKEN};

static void key_report_stop(void) {
    if (keys_out.token != INVALID_DEFERRED_TOKEN) {
        cancel_deferred_exec(keys_out.token);
        keys_out.token = INVALID_DEFERRED_TOKEN;
    }
    keys_out.on    = false;
    keys_out.count = 0;
}

static void key_report_note(keypos_t key, bool pressed) {
    if (!keys_out.on) return;
    if (keys_out.count == PS_KEY_QUEUE) {
        if (keys_out.dropped < 255) keys_out.dropped++;
        return;
    }
    uint8_t i               = (keys_out.head + keys_out.count++) % PS_KEY_QUEUE;
    keys_out.queue[i].row     = key.row;
    keys_out.queue[i].col     = key.col;
    keys_out.queue[i].pressed = pressed;
}

/* To the app, which only ever talks over USB. On Keychron's wireless boards raw_hid_send goes to
 * the active transport, which is Bluetooth / 2.4 GHz when the mode switch says so even with the
 * cable in: send on the USB driver itself, as Keychron's kc_raw_hid_send does for its USB replies.
 * Without a USB host it returns at once. */
#ifdef LK_WIRELESS_ENABLE
extern host_driver_t chibios_driver;
#    define ps_send_report(buf) chibios_driver.send_raw_hid((buf), 32)
#else
#    define ps_send_report(buf) raw_hid_send((buf), 32)
#endif

/* [PS_KEY_REPORT_ID, n, dropped, n x (row, col, pressed)] */
static uint32_t key_report_flush(uint32_t trigger_time, void *cb_arg) {
    if (TIMER_DIFF_32(timer_read32(), keys_out.renewed) >= PS_KEY_REPORT_TIMEOUT_MS) {
        keys_out.token = INVALID_DEFERRED_TOKEN; /* this callback ends: returning 0 drops it */
        key_report_stop();
        return 0;
    }
    if (keys_out.count || keys_out.dropped) {
        uint8_t buf[32] = {PS_KEY_REPORT_ID};
        uint8_t n       = keys_out.count > PS_KEYS_PER_REPORT ? PS_KEYS_PER_REPORT : keys_out.count;
        buf[1]          = n;
        buf[2]          = keys_out.dropped;
        for (uint8_t k = 0; k < n; k++) {
            uint8_t i      = (keys_out.head + k) % PS_KEY_QUEUE;
            buf[3 + k * 3] = keys_out.queue[i].row;
            buf[4 + k * 3] = keys_out.queue[i].col;
            buf[5 + k * 3] = keys_out.queue[i].pressed;
        }
        keys_out.head = (keys_out.head + n) % PS_KEY_QUEUE;
        keys_out.count -= n;
        keys_out.dropped = 0;
        ps_send_report(buf);
    }
    return PS_KEY_FLUSH_MS;
}

/* KEY_REPORT 1 starts reporting or renews it; 0 stops it. Returns whether it is reporting now:
 * the reply carries it, since starting needs a free deferred-exec slot (a keymap of the user's may
 * have taken them all). */
static bool key_report_set(uint8_t on) {
    if (!on) {
        key_report_stop();
        return false;
    }
    keys_out.renewed = timer_read32();
    if (keys_out.on) return true;
    keys_out.head = keys_out.count = keys_out.dropped = 0;
    keys_out.token = defer_exec(PS_KEY_FLUSH_MS, key_report_flush, NULL);
    keys_out.on    = keys_out.token != INVALID_DEFERRED_TOKEN; /* no free slot: stays off */
    return keys_out.on;
}

#ifdef PS_LED_COUNT
static void note_hit(keypos_t key);
#endif

/* Macro keys are consumed here; everything else goes on to the keymap's own hooks. */
bool pre_process_record_kb(uint16_t keycode, keyrecord_t *record) {
    key_report_note(record->event.key, record->event.pressed);
#ifdef RGB_MATRIX_ENABLE
    /* The user adjusts the lighting on the keyboard: stop re-applying the app's until it sends new. */
    if (record->event.pressed && (IS_RGB_MATRIX_KEYCODE(keycode) || IS_UNDERGLOW_KEYCODE(keycode))) want.on = false;
#endif
#ifdef PS_LED_COUNT
    if (record->event.pressed) note_hit(record->event.key);
#endif
    if (keycode >= QK_USER && keycode < QK_USER + PS_MAX_MACROS && from_overlay(record->event.key, keycode)) {
        if (record->event.pressed) start_macro(keycode - QK_USER);
        return false;
    }
    return pre_process_record_user(keycode, record);
}

/* ------------------------------------------------------------------ swap */

static void index_macros(void) {
    macro_count = 0;
    uint16_t pos = 0;
    while (pos < active.macro_len && macro_count < PS_MAX_MACROS) {
        macro_start[macro_count++] = pos;
        while (pos < active.macro_len && active.macros[pos] != OP_END) pos += 3;
        pos++; /* terminator */
    }
}

static bool matrix_idle(void) {
    for (uint8_t row = 0; row < MATRIX_ROWS; row++) {
        if (matrix_get_row(row)) return false;
    }
    return true;
}

static void swap_now(void) {
    stop_macro();
    memcpy(&active, &staged, sizeof(active));
    index_macros();
    swap_pending = false;
}

/* A key pressed before the swap would be released through the new map and stick (Alt+Tab holds
 * Alt during the focus change), so wait until nothing is held. */
static uint32_t swap_when_idle(uint32_t trigger_time, void *cb_arg) {
    if (!matrix_idle()) return PS_IDLE_POLL_MS;
    swap_now();
    swap_token = INVALID_DEFERRED_TOKEN;
    return 0;
}

static void cancel_swap(void) {
    if (swap_token != INVALID_DEFERRED_TOKEN) {
        cancel_deferred_exec(swap_token);
        swap_token = INVALID_DEFERRED_TOKEN;
    }
    swap_pending = false;
}

static void commit(uint16_t tag) {
    staged.tag = tag;
    stop_macro();
    cancel_swap();
    if (matrix_idle()) {
        swap_now();
        return;
    }
    swap_pending = true;
    swap_token   = defer_exec(PS_IDLE_POLL_MS, swap_when_idle, NULL);
    if (swap_token == INVALID_DEFERRED_TOKEN) swap_now(); /* no free slot: better late than never */
}

/* ------------------------------------------------------------------ overlay */

/* Each layer's remaps sit over that layer, so QMK's own layer logic (the Mac/Win switch, Fn keys,
 * transparent keys falling through) works on the remapped keymap as it would on the real one. */
uint16_t keymap_key_to_keycode(uint8_t layer, keypos_t key) {
    const ps_layer_t *m = layer < PS_LAYERS ? &active.layer[layer] : NULL;
    if (key.row < MATRIX_ROWS && key.col < MATRIX_COLS) {
        if (m && m->keys[key.row][key.col] != KC_TRNS) return m->keys[key.row][key.col];
        return keycode_at_keymap_location(layer, key.row, key.col);
    }
#ifdef ENCODER_MAP_ENABLE
    else if (key.row == KEYLOC_ENCODER_CW && key.col < NUM_ENCODERS) {
        if (m && m->encoders[key.col][1] != KC_TRNS) return m->encoders[key.col][1];
        return keycode_at_encodermap_location(layer, key.col, true);
    } else if (key.row == KEYLOC_ENCODER_CCW && key.col < NUM_ENCODERS) {
        if (m && m->encoders[key.col][0] != KC_TRNS) return m->encoders[key.col][0];
        return keycode_at_encodermap_location(layer, key.col, false);
    }
#endif
#ifdef DIP_SWITCH_MAP_ENABLE
    else if (key.row == KEYLOC_DIP_SWITCH_ON && key.col < NUM_DIP_SWITCHES) {
        return keycode_at_dip_switch_map_location(key.col, true);
    } else if (key.row == KEYLOC_DIP_SWITCH_OFF && key.col < NUM_DIP_SWITCHES) {
        return keycode_at_dip_switch_map_location(key.col, false);
    }
#endif
    return KC_NO;
}

/* ------------------------------------------------------------------ per-key colours */

#ifdef PS_LED_COUNT
/* Keys without a colour of their own show the effect underneath, or black with this flag. */
#    define PS_RGB_BLANK_OTHERS 0x01

/* How a key's colour moves. */
enum { PS_ANIM_STATIC = 0, PS_ANIM_BREATHE = 1, PS_ANIM_CYCLE = 2, PS_ANIM_REACTIVE = 3 };

typedef struct {
    uint8_t h, s, v;
    bool    on;
    uint8_t anim, speed;
} ps_led_t;

static ps_led_t led_active[PS_LED_COUNT];
static ps_led_t led_staged[PS_LED_COUNT];
static uint8_t  led_flags_active, led_flags_staged;
/* When each key was last pressed, for PS_ANIM_REACTIVE. */
static uint32_t led_hit_at[PS_LED_COUNT];
static bool     led_hit[PS_LED_COUNT];

static void rgb_begin(uint8_t flags) {
    memset(led_staged, 0, sizeof(led_staged));
    led_flags_staged = flags;
}

static uint8_t led_at(uint8_t row, uint8_t col) {
    if (row >= MATRIX_ROWS || col >= MATRIX_COLS) return NO_LED;
    uint8_t led = g_led_config.matrix_co[row][col];
    return led < PS_LED_COUNT ? led : NO_LED;
}

/* n (<= per_packet) x row, col, h, s, v[, anim, speed]. The keyboard's own matrix -> LED map picks
 * the LED. */
static void rgb_keys(uint8_t *p, uint8_t per_packet, uint8_t size) {
    uint8_t n = p[0] > per_packet ? per_packet : p[0];
    for (uint8_t i = 0; i < n; i++) {
        uint8_t *e   = &p[1 + i * size];
        uint8_t  led = led_at(e[0], e[1]);
        if (led == NO_LED) continue;
        led_staged[led] = (ps_led_t){.h = e[2], .s = e[3], .v = e[4], .on = true};
        if (size == 7 && e[5] <= PS_ANIM_REACTIVE) {
            led_staged[led].anim  = e[5];
            led_staged[led].speed = e[6];
        }
    }
}

static void note_hit(keypos_t key) {
    uint8_t led = led_at(key.row, key.col);
    if (led == NO_LED) return;
    led_hit_at[led] = timer_read32();
    led_hit[led]    = true;
}

/* 0 -> 255 -> 0 over `period` ms. */
static uint8_t ps_triangle(uint32_t now, uint32_t period) {
    uint32_t t = (now % period) * 510 / period;
    return t < 256 ? t : 510 - t;
}

/* The colour a key shows now, or false for "not lit at the moment" (a reactive key at rest). The
 * slowest speed (0) is the longest period, like QMK's own effects. White backlights only use v
 * (the app doesn't offer a colour cycle there). */
static bool ps_animate(const ps_led_t *l, uint8_t led, uint32_t now, HSV *out) {
    *out = (HSV){.h = l->h, .s = l->s, .v = l->v};
    switch (l->anim) {
        case PS_ANIM_BREATHE: {
            uint8_t w = ps_triangle(now, 6000 - (uint32_t)l->speed * 20); /* 6 s .. 0.9 s */
            w         = (uint16_t)w * w / 255;                          /* eased: longer at the bottom */
            out->v    = (uint16_t)l->v * (40 + (uint16_t)w * 215 / 255) / 255;
            return true;
        }
        case PS_ANIM_CYCLE: {
            uint32_t period = 12000 - (uint32_t)l->speed * 40; /* 12 s .. 1.8 s round the wheel */
            out->h          = l->h + (uint8_t)((now % period) * 256 / period);
            return true;
        }
        case PS_ANIM_REACTIVE: {
            uint32_t fade = 2000 - (uint32_t)l->speed * 7; /* 2 s .. 0.2 s */
            if (!led_hit[led]) return false;
            uint32_t age = TIMER_DIFF_32(now, led_hit_at[led]);
            if (age >= fade) {
                led_hit[led] = false;
                return false;
            }
            out->v = (uint32_t)l->v * (fade - age) / fade;
            return true;
        }
        default:
            return true;
    }
}

/* Colours change at once: no stuck-key hazard, unlike remaps. */
static void rgb_commit(void) {
    memcpy(led_active, led_staged, sizeof(led_active));
    led_flags_active = led_flags_staged;
}
#endif

#ifdef RGB_MATRIX_ENABLE
/* Keychron's rgb_task_render reloads hue, saturation, brightness and speed from EEPROM whenever the
 * effect changes, and when the lighting wakes from its idle timeout. Values set over Raw HID a few
 * ms earlier are lost: a Solid Color profile comes out in the saved hue (red by default). So the app
 * sends its lighting here, and for a short while after any effect (re)start the module writes it
 * back over the reload. Lighting keys (Fn + ...) hand control back to the keyboard. */
#    define PS_REASSERT_MS 80  /* covers the first full frame, rendered in several batches */
#    define PS_RESTART_GAP_MS 100 /* no frame for this long: the lighting was off or asleep */

static uint32_t reassert_until;
static uint32_t last_frame;
static uint8_t  last_mode = 0xFF;

static void lighting_set(uint8_t *p) {
    want = (typeof(want)){
        .on    = true,
        .h     = p[1],
        .s     = p[2],
        .v     = (uint16_t)p[3] * RGB_MATRIX_MAXIMUM_BRIGHTNESS / 255, /* same scale as VIA */
        .speed = p[4],
    };
    if (p[0] == 0) {
        rgb_matrix_disable_noeeprom();
        return;
    }
    rgb_matrix_enable_noeeprom();
    rgb_matrix_mode_noeeprom(p[0]);
    rgb_matrix_sethsv_noeeprom(want.h, want.s, want.v);
    rgb_matrix_set_speed_noeeprom(want.speed);
    reassert_until = timer_read32() + PS_REASSERT_MS;
}

/* Called at the start of every indicator pass (several per frame). */
static void lighting_keep(void) {
    uint32_t now      = timer_read32();
    uint8_t  mode     = rgb_matrix_get_mode();
    bool     restarted = mode != last_mode || TIMER_DIFF_32(now, last_frame) > PS_RESTART_GAP_MS;
    last_mode  = mode;
    last_frame = now;
    if (restarted) {
        reassert_until = now + PS_REASSERT_MS;
#    ifdef ENABLE_RGB_MATRIX_PIXEL_RAIN
        /* Pixel Rain only ever repaints one key at a time, so it would rain over a frozen frame
         * of the previous effect. Start it from black, as after power-on. */
        if (mode == RGB_MATRIX_PIXEL_RAIN) rgb_matrix_set_color_all(0, 0, 0);
#    endif
    }
    if (want.on && (int32_t)(reassert_until - now) >= 0) {
        rgb_matrix_config.hsv.h = want.h;
        rgb_matrix_config.hsv.s = want.s;
        rgb_matrix_config.hsv.v = want.v;
        rgb_matrix_config.speed = want.speed;
    }
}

/* Runs after the effect (and Keychron's lock indicators) has drawn each frame, so the colours
 * sit on top of any animation. Scaled by the global brightness like the effect itself. Painted
 * before the keymap's own advanced indicators, which stay on top. */
static void rgb_paint(uint8_t led_min, uint8_t led_max) {
    lighting_keep();
    uint8_t  brightness = rgb_matrix_get_val();
    uint32_t now        = timer_read32();
    for (uint8_t i = led_min; i < led_max && i < RGB_MATRIX_LED_COUNT; i++) {
        HSV hsv;
        if (led_active[i].on && ps_animate(&led_active[i], i, now, &hsv)) {
            hsv.v   = (uint16_t)hsv.v * brightness / 255;
            RGB rgb = hsv_to_rgb(hsv);
            rgb_matrix_set_color(i, rgb.r, rgb.g, rgb.b);
        } else if (led_flags_active & PS_RGB_BLANK_OTHERS) {
            rgb_matrix_set_color(i, 0, 0, 0);
        }
    }
}

#    ifdef PS_INDICATORS_USER
bool rgb_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max) {
    rgb_paint(led_min, led_max);
    return true;
}
#    else
bool rgb_matrix_indicators_advanced_kb(uint8_t led_min, uint8_t led_max) {
    rgb_paint(led_min, led_max);
    return rgb_matrix_indicators_advanced_user(led_min, led_max);
}
#    endif

#elif defined(LED_MATRIX_ENABLE)
/* White backlights: the same layers as brightness, over the effect and scaled by the global
 * brightness. Keychron's LED matrix keeps VIA's effect, brightness and speed (no EEPROM reload), so
 * the app sets those through VIA's own LED matrix channel. */
static void led_paint(uint8_t led_min, uint8_t led_max) {
    uint8_t  brightness = led_matrix_get_val();
    uint32_t now        = timer_read32();
    for (uint8_t i = led_min; i < led_max && i < LED_MATRIX_LED_COUNT; i++) {
        HSV hsv;
        if (led_active[i].on && ps_animate(&led_active[i], i, now, &hsv)) {
            led_matrix_set_value(i, (uint16_t)hsv.v * brightness / 255);
        } else if (led_flags_active & PS_RGB_BLANK_OTHERS) {
            led_matrix_set_value(i, 0);
        }
    }
}

#    ifdef PS_INDICATORS_USER
bool led_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max) {
    led_paint(led_min, led_max);
    return true;
}
#    else
bool led_matrix_indicators_advanced_kb(uint8_t led_min, uint8_t led_max) {
    led_paint(led_min, led_max);
    return led_matrix_indicators_advanced_user(led_min, led_max);
}
#    endif
#endif

/* ------------------------------------------------------------------ bootloader */

/* After the reply went out: VIA sends it once via_custom_value_command_kb returns. */
static uint32_t enter_bootloader(uint32_t trigger_time, void *cb_arg) {
    reset_keyboard();
    return 0;
}

/* BOOTLOADER "BOOT": restart into the bootloader, ready to flash (instead of holding Esc while
 * plugging the keyboard in). The magic word keeps a stray packet from doing it. */
static void request_bootloader(uint8_t *p) {
    if (p[0] != 'B' || p[1] != 'O' || p[2] != 'O' || p[3] != 'T') return;
    if (defer_exec(50, enter_bootloader, NULL) == INVALID_DEFERRED_TOKEN) reset_keyboard();
}

/* ------------------------------------------------------------------ Raw HID (VIA channel 0) */

static void reset_staged(void) {
    cancel_swap(); /* a half-staged profile must never go live */
    for (uint8_t l = 0; l < PS_LAYERS; l++) {
        for (uint8_t row = 0; row < MATRIX_ROWS; row++) {
            for (uint8_t col = 0; col < MATRIX_COLS; col++) staged.layer[l].keys[row][col] = KC_TRNS;
        }
#ifdef PS_HAS_ENCODERS
        for (uint8_t i = 0; i < NUM_ENCODERS; i++) staged.layer[l].encoders[i][0] = staged.layer[l].encoders[i][1] = KC_TRNS;
#endif
    }
    staged.macro_len = 0;
    staged.tag       = 0;
}

/* The staged remaps of a layer (PS_DEFAULT_LAYER: the current default layer), NULL if the overlay
 * doesn't cover it. */
static ps_layer_t *staged_layer(uint8_t layer) {
    if (layer == PS_DEFAULT_LAYER) layer = get_highest_layer(default_layer_state);
    return layer < PS_LAYERS ? &staged.layer[layer] : NULL;
}

/* n (<= max) x row, col, kc_hi, kc_lo */
static void stage_keys(ps_layer_t *m, uint8_t *p, uint8_t max) {
    if (!m) return;
    uint8_t n = p[0] > max ? max : p[0];
    for (uint8_t i = 0; i < n; i++) {
        uint8_t *e = &p[1 + i * 4];
        if (e[0] < MATRIX_ROWS && e[1] < MATRIX_COLS) m->keys[e[0]][e[1]] = (uint16_t)e[2] << 8 | e[3];
    }
}

/* n (<= max) x index, clockwise, kc_hi, kc_lo */
static void stage_encoders(ps_layer_t *m, uint8_t *p, uint8_t max) {
#ifdef PS_HAS_ENCODERS
    if (!m) return;
    uint8_t n = p[0] > max ? max : p[0];
    for (uint8_t i = 0; i < n; i++) {
        uint8_t *e = &p[1 + i * 4];
        if (e[0] < NUM_ENCODERS) m->encoders[e[0]][e[1] ? 1 : 0] = (uint16_t)e[2] << 8 | e[3];
    }
#endif
}

static void set_value(uint8_t id, uint8_t *p) {
    switch (id) {
        case PS_BEGIN:
            reset_staged();
            break;
        /* layer (PS_DEFAULT_LAYER: the current default one), n, then n x 4 bytes, at most 6. */
        case PS_LAYER_KEYS:
            stage_keys(staged_layer(p[0]), &p[1], 6);
            break;
        case PS_LAYER_ENCODERS:
            stage_encoders(staged_layer(p[0]), &p[1], 6);
            break;
        case PS_BOOTLOADER:
            request_bootloader(p);
            break;
        case PS_KEY_REPORT:
            p[0] = key_report_set(p[0]); /* the reply says whether it is reporting */
            break;
        case PS_MACRO_DATA: {
            uint16_t off = (uint16_t)p[0] << 8 | p[1];
            uint8_t  len = p[2] > 26 ? 26 : p[2];
            if (off + len > PS_MACRO_BUFFER_SIZE) break;
            memcpy(&staged.macros[off], &p[3], len);
            if (off + len > staged.macro_len) staged.macro_len = off + len;
            break;
        }
        case PS_COMMIT:
            commit((uint16_t)p[0] << 8 | p[1]);
            break;
#ifdef PS_LED_COUNT
        case PS_RGB_BEGIN:
            rgb_begin(p[0]);
            break;
        case PS_RGB_KEYS:
            rgb_keys(p, 5, 5);
            break;
        case PS_RGB_KEYS_ANIM:
            rgb_keys(p, 4, 7);
            break;
        case PS_RGB_COMMIT:
            rgb_commit();
            break;
#endif
#ifdef RGB_MATRIX_ENABLE
        case PS_LIGHTING:
            lighting_set(p);
            break;
#endif
    }
}

static void get_value(uint8_t id, uint8_t *p) {
    if (id != PS_STATUS) return;
    p[0] = PS_PROTO_VERSION;
    p[1] = swap_pending;
    p[2] = active.tag >> 8;
    p[3] = active.tag & 0xFF;
    p[4] = PS_MACRO_BUFFER_SIZE >> 8;
    p[5] = PS_MACRO_BUFFER_SIZE & 0xFF;
    p[6] = PS_MAX_MACROS;
    p[7] = PS_LAYERS;
    p[8]  = (uint8_t)(((uint32_t)PS_BUILD_ID) >> 24);
    p[9]  = (uint8_t)(((uint32_t)PS_BUILD_ID) >> 16);
    p[10] = (uint8_t)(((uint32_t)PS_BUILD_ID) >> 8);
    p[11] = (uint8_t)((uint32_t)PS_BUILD_ID);
}

/* VIA handles channels 1-3 itself and calls this for the rest. The reply is the same buffer,
 * which VIA sends after we return. */
void via_custom_value_command_kb(uint8_t *data, uint8_t length) {
    uint8_t *command_id = &data[0];
    uint8_t  channel_id = data[1];
    uint8_t  value_id   = data[2];
    if (channel_id != id_custom_channel || length < 32) {
        *command_id = id_unhandled;
        return;
    }
    switch (*command_id) {
        case id_custom_set_value:
            set_value(value_id, &data[3]);
            break;
        case id_custom_get_value:
            get_value(value_id, &data[3]);
            break;
        case id_custom_save:
            break; /* nothing is ever saved */
        default:
            *command_id = id_unhandled;
            break;
    }
}
