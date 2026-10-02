/* Runs profile_switcher.c on a PC against stand-ins for QMK, replaying packets the app itself
 * built (fixture.h, written by the Rust test protocol::tests::firmware_fixture).
 * Run: firmware/test/run.sh */

#include <stdio.h>
#include "qmk_stubs.h"
#include "../profile_switcher.c"
#include "fixture.h"

static int failures;
#define CHECK(cond, ...)                                          \
    do {                                                          \
        if (!(cond)) {                                            \
            failures++;                                           \
            printf("FAIL line %d: %s: ", __LINE__, #cond);        \
            printf(__VA_ARGS__);                                  \
            printf("\n");                                         \
        }                                                         \
    } while (0)

/* ------------------------------------------------------------------ fake keyboard */

layer_state_t       default_layer_state = 1u << 2; /* WIN_BASE */
static matrix_row_t matrix[MATRIX_ROWS];
static uint32_t     now;

matrix_row_t matrix_get_row(uint8_t row) {
    return matrix[row];
}
/* 4,4 holds a custom keycode of the keymap's own, at SAFE_RANGE (= QK_USER) like QMK keymaps do. */
#define USER_CUSTOM_ROW 4
#define USER_CUSTOM_COL 4
uint16_t keycode_at_keymap_location(uint8_t layer, uint8_t row, uint8_t col) {
    if (row == USER_CUSTOM_ROW && col == USER_CUSTOM_COL) return QK_USER;
    return 0x2000 + layer * 200 + row * MATRIX_COLS + col;
}
uint16_t keycode_at_encodermap_location(uint8_t layer, uint8_t idx, bool cw) {
    return 0x3000 + layer * 10 + idx * 2 + cw;
}
/* The layer QMK read a key's keycode from: the default layer unless a test holds Fn (key_layer). */
bool           disable_action_cache;
static uint8_t key_layer = 0xFF;
static uint8_t layer_of_key(void) {
    return key_layer != 0xFF ? key_layer : get_highest_layer(default_layer_state);
}
uint8_t read_source_layers_cache(keypos_t key) {
    return layer_of_key();
}
uint8_t layer_switch_get_layer(keypos_t key) {
    return layer_of_key();
}
static int user_hook_calls;
bool pre_process_record_user(uint16_t keycode, keyrecord_t *record) {
    user_hook_calls++;
    return true;
}

/* RGB matrix: what the last frame painted over the effect. */
led_config_t    g_led_config;
static uint8_t  global_val = 255;
static RGB      painted[RGB_MATRIX_LED_COUNT];
static bool     was_painted[RGB_MATRIX_LED_COUNT];
static int      advanced_user_calls;
RGB hsv_to_rgb(HSV hsv) {
    return (RGB){hsv.h, hsv.s, hsv.v};
}
uint8_t rgb_matrix_get_val(void) {
    return global_val;
}
void rgb_matrix_set_color(int i, uint8_t r, uint8_t g, uint8_t b) {
    painted[i]     = (RGB){r, g, b};
    was_painted[i] = true;
}
bool rgb_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max) {
    advanced_user_calls++;
    return true;
}
static void frame(void) {
    memset(was_painted, 0, sizeof(was_painted));
    rgb_matrix_indicators_advanced_kb(0, RGB_MATRIX_LED_COUNT);
}
static uint8_t led(uint8_t row, uint8_t col) {
    return g_led_config.matrix_co[row][col];
}

/* A model of Keychron's rgb_matrix_task: while the effect differs from the last flushed one, every
 * render batch first reloads hue/sat/val and speed from EEPROM (rgb_task_render in their fork),
 * then the indicator hooks run. Two batches per frame, 8 ms apart. Asleep: no rendering. */
rgb_config_t    rgb_matrix_config = {.enable = 1, .mode = RGB_MATRIX_CYCLE_LEFT_RIGHT, .hsv = {0, 255, 200}, .speed = 127};
static const HSV EEPROM_HSV       = {0, 255, 200}; /* the saved lighting: hue 0 = red */
static const uint8_t EEPROM_SPEED = 127;
static uint8_t  kc_last_effect    = RGB_MATRIX_CYCLE_LEFT_RIGHT;
static bool     asleep;
uint8_t rgb_matrix_get_mode(void) {
    return rgb_matrix_config.mode;
}
void rgb_matrix_enable_noeeprom(void) {
    rgb_matrix_config.enable = 1;
}
void rgb_matrix_disable_noeeprom(void) {
    rgb_matrix_config.enable = 0;
}
void rgb_matrix_mode_noeeprom(uint8_t mode) {
    if (rgb_matrix_config.enable) rgb_matrix_config.mode = mode;
}
void rgb_matrix_sethsv_noeeprom(uint16_t h, uint8_t s, uint8_t v) {
    if (rgb_matrix_config.enable) rgb_matrix_config.hsv = (HSV){h, s, v};
}
void rgb_matrix_set_speed_noeeprom(uint8_t speed) {
    rgb_matrix_config.speed = speed;
}
void rgb_matrix_set_color_all(uint8_t r, uint8_t g, uint8_t b) {
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) rgb_matrix_set_color(i, r, g, b);
}
uint32_t timer_read32(void) {
    return now;
}
static void keychron_frame(void) {
    uint8_t effect = asleep || !rgb_matrix_config.enable ? 0 : rgb_matrix_config.mode;
    memset(was_painted, 0, sizeof(was_painted));
    for (int batch = 0; batch < 2; batch++) {
        now += 8; /* batches run in separate rgb_matrix_task calls, milliseconds apart */
        if (effect != kc_last_effect) {
            rgb_matrix_config.hsv   = EEPROM_HSV;
            rgb_matrix_config.speed = EEPROM_SPEED;
        }
        if (effect) rgb_matrix_indicators_advanced_kb(batch * 63, batch * 63 + 63);
    }
    kc_last_effect = effect;
}
static void frames(int n) {
    while (n--) keychron_frame();
}

/* What the macros sent to the host: 'P'ress, 'R'elease, 'T'ap. */
static struct {
    char     kind;
    uint16_t kc;
    uint32_t at;
} out[64];
static int out_count;
static void emit(char kind, uint16_t kc) {
    if (out_count < 64) out[out_count++] = (typeof(out[0])){kind, kc, now};
}
void register_code16(uint16_t kc) {
    emit('P', kc);
}
void unregister_code16(uint16_t kc) {
    emit('R', kc);
}
void tap_code16(uint16_t kc) {
    emit('T', kc);
}
static int resets;
void reset_keyboard(void) {
    resets++;
}

/* Deferred exec: a tiny scheduler driven by run_for(). */
static struct {
    deferred_token         token;
    uint32_t               due;
    deferred_exec_callback cb;
    void                  *arg;
} slots[8];
static deferred_token next_token = 1;

deferred_token defer_exec(uint32_t delay_ms, deferred_exec_callback cb, void *arg) {
    for (int i = 0; i < 8; i++) {
        if (!slots[i].token) {
            slots[i] = (typeof(slots[0])){next_token++, now + delay_ms, cb, arg};
            return slots[i].token;
        }
    }
    return INVALID_DEFERRED_TOKEN;
}
bool cancel_deferred_exec(deferred_token token) {
    for (int i = 0; i < 8; i++) {
        if (token && slots[i].token == token) {
            slots[i].token = 0;
            return true;
        }
    }
    return false;
}
static void run_for(uint32_t ms) {
    for (uint32_t end = now + ms; now < end;) {
        now++;
        for (int i = 0; i < 8; i++) {
            if (slots[i].token && slots[i].due <= now) {
                uint32_t again = slots[i].cb(now, slots[i].arg);
                if (again) slots[i].due = now + again;
                else slots[i].token = 0;
            }
        }
    }
}
static int pending_callbacks(void) {
    int n = 0;
    for (int i = 0; i < 8; i++) n += slots[i].token != 0;
    return n;
}

/* ------------------------------------------------------------------ helpers */

static uint8_t reply[32];
static void send(const uint8_t *packet) {
    memcpy(reply, packet, 32);
    via_custom_value_command_kb(reply, 32);
}
static void send_fixture(void) {
    for (size_t i = 0; i < sizeof FIXTURE_PACKETS / sizeof FIXTURE_PACKETS[0]; i++) {
        send(FIXTURE_PACKETS[i]);
        CHECK(reply[0] == FIXTURE_PACKETS[i][0], "packet %zu was not handled (reply 0x%02X)", i, reply[0]);
    }
}
static const uint8_t BEGIN[32]    = {0x07, 0x00, 0x01};
static const uint8_t COMMIT_1[32] = {0x07, 0x00, 0x05, 0x00, 0x01};
static const uint8_t STATUS[32]   = {0x08, 0x00, 0x10};

static uint16_t lookup(uint8_t layer, uint8_t row, uint8_t col) {
    return keymap_key_to_keycode(layer, (keypos_t){.row = row, .col = col});
}
static uint16_t base(uint8_t layer, uint8_t row, uint8_t col) {
    return keycode_at_keymap_location(layer, row, col);
}
/* A key event as QMK would process it on the default layer. */
static bool key_event(uint8_t row, uint8_t col, bool pressed) {
    keyrecord_t rec = {.event = {.key = {.col = col, .row = row}, .pressed = pressed}};
    return pre_process_record_kb(lookup(get_highest_layer(default_layer_state), row, col), &rec);
}

/* ------------------------------------------------------------------ tests */

static void test_starts_transparent(void) {
    CHECK(lookup(2, 3, 1) == base(2, 3, 1), "overlay must start as KC_TRNS");
    CHECK(lookup(2, KEYLOC_ENCODER_CW, 0) == keycode_at_encodermap_location(2, 0, true), "encoder too");
    send(STATUS);
    CHECK(reply[3] == PS_PROTO_VERSION && reply[3] == 1 && reply[4] == 0 && reply[5] == 0 && reply[6] == 0, "status before any profile");
    CHECK(reply[10] == 4, "holds VIA's 4 layers (%d)", reply[10]);
    CHECK(reply[7] == 0x08 && reply[8] == 0x00 && reply[9] == 64, "buffer size / slots");
    /* The build id the app stamps in (run.sh builds this test with one). */
    CHECK(reply[11] == 0xDE && reply[12] == 0xAD && reply[13] == 0xBE && reply[14] == 0xEF, "build id %02X%02X%02X%02X", reply[11], reply[12],
          reply[13], reply[14]);
}

static void test_fixture_applies(void) {
    send_fixture();
    send(STATUS);
    CHECK((reply[5] << 8 | reply[6]) == FIXTURE_TAG, "active tag 0x%04X, app sent 0x%04X", reply[5] << 8 | reply[6], FIXTURE_TAG);
    CHECK(reply[4] == 0, "idle keyboard: no pending swap");

    CHECK(lookup(2, 3, 1) == 0x0014, "3,1 remapped to KC_Q, got 0x%04X", lookup(2, 3, 1));
    CHECK(lookup(2, 1, 1) == KC_NO, "1,1 disabled");
    CHECK(lookup(2, 0, 0) == base(2, 0, 0), "untouched key keeps its keymap");
    CHECK(lookup(3, 3, 1) == 0x003A, "layer 3: 3,1 remapped to KC_F1, got 0x%04X", lookup(3, 3, 1));
    CHECK(lookup(3, 0, 0) == base(3, 0, 0), "layer 3: untouched key keeps its keymap");
    CHECK(lookup(3, 1, 2) == QK_USER + 2, "layer 3: 1,2 -> macro slot 2");
    CHECK(lookup(3, KEYLOC_ENCODER_CCW, 0) == 0x0081, "layer 3: knob ccw");
    CHECK(lookup(3, KEYLOC_ENCODER_CW, 0) == keycode_at_encodermap_location(3, 0, true), "layer 3: knob cw untouched");
    CHECK(lookup(0, 4, 2) == 0x0005, "layer 0: 4,2 remapped to KC_B");
    CHECK(lookup(2, 4, 2) == base(2, 4, 2), "…on layer 0 only");
    CHECK(lookup(1, 3, 1) == base(1, 3, 1) && lookup(4, 3, 1) == base(4, 3, 1), "other layers untouched");
    CHECK(lookup(200, 3, 1) == base(200, 3, 1), "a layer past the overlay is the keymap's");
    CHECK(lookup(2, 0, 5) == QK_USER, "0,5 -> macro slot 0");
    CHECK(lookup(2, 2, 2) == QK_USER + 1, "2,2 -> macro slot 1");
    CHECK(lookup(2, KEYLOC_ENCODER_CW, 0) == 0x0106, "knob clockwise -> LCTL(KC_C)");
    CHECK(lookup(2, KEYLOC_ENCODER_CCW, 0) == keycode_at_encodermap_location(2, 0, false), "knob ccw untouched");
}

static void test_remaps_stay_on_their_layer(void) {
    /* The Mac/Win switch changes the default layer; each layer keeps its own remaps. */
    default_layer_state = 1u << 0; /* MAC_BASE */
    CHECK(lookup(0, 4, 2) == 0x0005, "layer 0's remap");
    CHECK(lookup(0, 3, 1) == base(0, 3, 1), "layer 2's remaps don't move to layer 0");
    CHECK(lookup(2, 3, 1) == 0x0014, "…they stay on layer 2");
    default_layer_state = 1u << 2;
}

static void test_layer_packets(void) {
    /* LAYER_KEYS with 0xFF: the current default layer; layers past the overlay are ignored. */
    static const uint8_t DEFAULT_KEY[32] = {0x07, 0x00, 0x0A, 0xFF, 1, 5, 5, 0x00, 0x06};
    static const uint8_t FAR_KEY[32]     = {0x07, 0x00, 0x0A, 9, 1, 5, 5, 0x00, 0x07};
    static const uint8_t SEVEN[32]       = {0x07, 0x00, 0x0A, 1, 7, 0, 1, 0, 4, 0, 2, 0, 4, 0, 3, 0, 4, 0, 4, 0, 4, 0, 5, 0, 4, 0, 6, 0, 4, 0, 7};
    static const uint8_t KNOB[32]        = {0x07, 0x00, 0x0B, 1, 1, 0, 1, 0x00, 0x80};
    send(BEGIN);
    send(DEFAULT_KEY);
    send(FAR_KEY);
    send(SEVEN);
    send(KNOB);
    CHECK(reply[0] == 0x07, "layer packets handled");
    send(COMMIT_1);
    CHECK(lookup(2, 5, 5) == 0x0006, "0xFF: on the default layer (2)");
    CHECK(lookup(1, 0, 6) == 0x0004, "layer 1: sixth key of the packet");
    CHECK(lookup(1, 0, 7) == base(1, 0, 7), "a seventh entry is past the packet's end and ignored");
    CHECK(lookup(1, KEYLOC_ENCODER_CW, 0) == 0x0080, "layer 1: knob");
    send_fixture(); /* back to the app's profile */
}

static void test_fn_layer_macro_plays(void) {
    out_count       = 0;
    user_hook_calls = 0;
    keyrecord_t rec = {.event = {.key = {.col = 2, .row = 1}, .pressed = true}};
    key_layer       = 3; /* Fn held */
    CHECK(pre_process_record_kb(lookup(3, 1, 2), &rec) == false, "Fn macro key is consumed");
    key_layer = 0xFF;
    run_for(30);
    CHECK(out_count == 2 && out[0].kind == 'P' && out[0].kc == 0x000D && out[1].kind == 'R', "Fn+key played its macro (%d events)", out_count);
    CHECK(user_hook_calls == 0, "and never reached the keymap");
}

static void test_macro_plays(void) {
    out_count       = 0;
    user_hook_calls = 0;
    uint32_t start  = now;
    CHECK(key_event(2, 2, true) == false, "macro key is consumed");
    CHECK(key_event(2, 2, false) == false, "…on release too");
    CHECK(user_hook_calls == 0, "and never reaches the keymap");
    run_for(100);
    /* Shift down, tap H, Shift up, 20 ms, tap I. A tap is a press held PS_TAP_HOLD_MS, then a release. */
    const char *want = "P00E1 P000B R000B R00E1 P000C R000C";
    char        got[128] = "";
    for (int i = 0; i < out_count; i++) sprintf(got + strlen(got), "%s%c%04X", i ? " " : "", out[i].kind, out[i].kc);
    CHECK(strcmp(got, want) == 0, "got \"%s\", want \"%s\"", got, want);
    if (out_count == 6) {
        CHECK(out[0].at - start <= 2, "starts right away");
        CHECK(out[2].at - out[1].at >= PS_TAP_HOLD_MS, "H held %u ms, want >= %d", (unsigned)(out[2].at - out[1].at), PS_TAP_HOLD_MS);
        CHECK(out[5].at - out[4].at >= PS_TAP_HOLD_MS, "I held long enough");
        CHECK(out[4].at - out[3].at >= 20, "20 ms delay honoured (%u ms)", (unsigned)(out[4].at - out[3].at));
    }
    CHECK(pending_callbacks() == 0, "nothing left running");

    CHECK(key_event(0, 0, true) == true && user_hook_calls == 1, "normal keys reach pre_process_record_user");
}

static void test_keymap_custom_keycodes_are_not_macros(void) {
    /* The overlay has macros (slots 0 and 1 = QK_USER, QK_USER+1), but 4,4 isn't remapped: its
     * QK_USER comes from the keymap and belongs to the keymap. */
    out_count       = 0;
    user_hook_calls = 0;
    CHECK(lookup(2, USER_CUSTOM_ROW, USER_CUSTOM_COL) == QK_USER, "setup: keymap's own custom keycode");
    CHECK(key_event(USER_CUSTOM_ROW, USER_CUSTOM_COL, true) == true, "passed on, not swallowed");
    CHECK(key_event(USER_CUSTOM_ROW, USER_CUSTOM_COL, false) == true, "release passed on too");
    run_for(30);
    CHECK(user_hook_calls == 2 && out_count == 0, "reached the keymap and played no macro");
}

static void test_a_macro_on_another_layer_leaves_the_keymaps_key_alone(void) {
    /* Macro slot 0 (QK_USER) on layer 3 at 4,4, where the keymap has its own custom keycode (also
     * QK_USER) on every layer. On layer 2 the key is the keymap's; on layer 3 it is the macro. */
    static const uint8_t L3_MACRO[32] = {0x07, 0x00, 0x0A, 3, 1, USER_CUSTOM_ROW, USER_CUSTOM_COL, 0x7E, 0x40};
    send(BEGIN);
    send(L3_MACRO);
    send(COMMIT_1);
    user_hook_calls = 0;
    CHECK(key_event(USER_CUSTOM_ROW, USER_CUSTOM_COL, true) == true, "layer 2: passed on, not taken for layer 3's macro");
    CHECK(key_event(USER_CUSTOM_ROW, USER_CUSTOM_COL, false) == true, "layer 2: release passed on too");
    CHECK(user_hook_calls == 2, "the keymap saw both (%d)", user_hook_calls);
    key_layer       = 3;
    keyrecord_t rec = {.event = {.key = {.col = USER_CUSTOM_COL, .row = USER_CUSTOM_ROW}, .pressed = true}};
    CHECK(pre_process_record_kb(lookup(3, USER_CUSTOM_ROW, USER_CUSTOM_COL), &rec) == false, "layer 3: the macro key is consumed");
    key_layer = 0xFF;
    send_fixture();
}

static void test_cutting_short_a_macro_releases_every_key_it_holds(void) {
    /* Ten keys down (A..J), then a long delay; the app re-sends the profile in the middle. */
    static const uint8_t KEY_5_1_MACRO_0[32] = {0x07, 0x00, 0x0A, 2, 1, 5, 1, 0x7E, 0x40};
    static const uint8_t DOWNS_1[32] = {0x07, 0x00, 0x04, 0, 0, 24, 2, 0, 0x04, 2, 0, 0x05, 2, 0, 0x06, 2, 0, 0x07,
                                        2, 0, 0x08, 2, 0, 0x09, 2, 0, 0x0A, 2, 0, 0x0B};
    static const uint8_t DOWNS_2[32] = {0x07, 0x00, 0x04, 0, 24, 10, 2, 0, 0x0C, 2, 0, 0x0D, 4, 0x03, 0xE8, 0};
    send(BEGIN);
    send(KEY_5_1_MACRO_0);
    send(DOWNS_1);
    send(DOWNS_2);
    send(COMMIT_1);
    out_count = 0;
    key_event(5, 1, true);
    run_for(50);
    CHECK(out_count == 10, "ten keys down (%d events)", out_count);
    send_fixture(); /* COMMIT stops the macro */
    run_for(20);
    int down = 0;
    for (int i = 0; i < out_count; i++) down += out[i].kind == 'P' ? 1 : -1;
    CHECK(down == 0, "every key the macro held was released (%d still down)", down);
}

/* Macro slot 0 on 5,1 (layer 2) with these bytes, made active. */
static void load_macro_0(const uint8_t *bytes, uint8_t len) {
    static const uint8_t KEY_5_1_MACRO_0[32] = {0x07, 0x00, 0x0A, 2, 1, 5, 1, 0x7E, 0x40};
    uint8_t data[32] = {0x07, 0x00, 0x04, 0, 0, len};
    memcpy(&data[6], bytes, len);
    send(BEGIN);
    send(KEY_5_1_MACRO_0);
    send(data);
    send(COMMIT_1);
}

static void test_macro_gap_between_key_steps(void) {
    /* Gap 10 ms: tap A, tap A, press B, 30 ms delay, release B. */
    static const uint8_t GAP[] = {5, 0, 10, 1, 0, 4, 1, 0, 4, 2, 0, 5, 4, 0, 30, 3, 0, 5, 0};
    load_macro_0(GAP, sizeof GAP);
    out_count = 0;
    key_event(5, 1, true);
    run_for(200);
    const char *want = "P0004 R0004 P0004 R0004 P0005 R0005";
    char        got[128] = "";
    for (int i = 0; i < out_count; i++) sprintf(got + strlen(got), "%s%c%04X", i ? " " : "", out[i].kind, out[i].kc);
    CHECK(strcmp(got, want) == 0, "got \"%s\", want \"%s\"", got, want);
    if (out_count == 6) {
        CHECK(out[1].at - out[0].at >= PS_TAP_HOLD_MS, "first A held");
        CHECK(out[2].at - out[1].at >= 10, "A released %u ms before it is pressed again, want >= 10", (unsigned)(out[2].at - out[1].at));
        CHECK(out[4].at - out[3].at >= 10, "gap before B");
        unsigned held = out[5].at - out[4].at;
        CHECK(held >= 30 && held < 40, "the 30 ms delay replaces the gap (B held %u ms)", held);
    }
    CHECK(pending_callbacks() == 0, "nothing left running");

    /* Gap 0 (and a macro without an OP_GAP): steps follow at once. */
    static const uint8_t NO_GAP[] = {5, 0, 0, 1, 0, 4, 1, 0, 4, 0};
    load_macro_0(NO_GAP, sizeof NO_GAP);
    out_count = 0;
    key_event(5, 1, true);
    run_for(100);
    CHECK(out_count == 4 && out[2].at == out[1].at, "no gap: pressed again at once (%d events)", out_count);
    send_fixture();
}

static void test_stopping_a_macro_mid_tap_releases_the_key(void) {
    out_count = 0;
    key_event(2, 2, true);
    run_for(12); /* Shift down, the 10 ms gap, H down: inside H's hold */
    send_fixture(); /* the app re-sends the profile: COMMIT stops running macros */
    run_for(50);
    int down = 0;
    for (int i = 0; i < out_count; i++) down += out[i].kind == 'P' ? 1 : -1;
    CHECK(down == 0, "every key the macro pressed was released (%d still down)", down);
}

static void test_macro_releases_what_it_held(void) {
    out_count = 0;
    key_event(0, 5, true);
    run_for(10);
    CHECK(out_count == 2 && out[0].kind == 'P' && out[1].kind == 'R' && out[1].kc == 0x0004,
          "a key left down by the macro is released at the end");
}

static void test_swap_waits_for_idle(void) {
    matrix[4] = 1 << 3; /* e.g. Alt held during Alt+Tab */
    send(BEGIN);
    send(COMMIT_1);
    send(STATUS);
    CHECK(reply[4] == 1, "swap pending while a key is held");
    CHECK(lookup(2, 3, 1) == 0x0014, "old profile still active");
    run_for(50);
    CHECK(lookup(2, 3, 1) == 0x0014, "still waiting");
    matrix[4] = 0;
    run_for(10);
    send(STATUS);
    CHECK(reply[4] == 0 && reply[6] == 0x01, "swapped once released");
    CHECK(lookup(2, 3, 1) == base(2, 3, 1), "empty profile is now active");
    CHECK(pending_callbacks() == 0, "poller stopped");
}

static void test_begin_cancels_a_pending_swap(void) {
    static const uint8_t KEY_3_1_B[32] = {0x07, 0x00, 0x0A, 2, 1, 3, 1, 0x00, 0x05}; /* layer 2: 3,1 -> KC_B */
    matrix[0] = 1;
    send_fixture(); /* goes pending */
    send(BEGIN);    /* a new profile starts staging… */
    send(KEY_3_1_B);
    matrix[0] = 0;  /* …and the keyboard goes idle before its COMMIT */
    run_for(20);
    CHECK(lookup(2, 3, 1) == base(2, 3, 1), "a half-staged profile went live (0x%04X)", lookup(2, 3, 1));
    send(COMMIT_1);
    CHECK(lookup(2, 3, 1) == 0x0005, "the new profile is active after its COMMIT");
}

static void test_per_key_colours(void) {
    frame();
    int n = 0;
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) n += was_painted[i];
    CHECK(n == 0, "nothing painted before any colours arrive");
    CHECK(advanced_user_calls == 1, "the keymap's own advanced indicators still run");

    for (size_t i = 0; i < sizeof FIXTURE_RGB_PACKETS / sizeof FIXTURE_RGB_PACKETS[0]; i++) {
        send(FIXTURE_RGB_PACKETS[i]);
        CHECK(reply[0] == 0x07, "rgb packet %zu handled", i);
    }
    frame();
    RGB red = painted[led(3, 1)], blue = painted[led(2, 2)];
    CHECK(was_painted[led(3, 1)] && red.r == 0 && red.g == 255 && red.b == 255, "3,1 red at full brightness");
    CHECK(was_painted[led(2, 2)] && blue.r == 170 && blue.b == 128, "2,2 blue at half value");
    CHECK(!was_painted[led(0, 0)], "keys without a colour keep the effect");

    global_val = 128;
    frame();
    CHECK(painted[led(3, 1)].b == 128, "scaled by the global brightness (%d)", painted[led(3, 1)].b);
    global_val = 255;

    /* Effect "off" with coloured keys: the others go black. */
    static const uint8_t BEGIN_BLANK[32] = {0x07, 0x00, 0x06, 0x01};
    static const uint8_t ONE_KEY[32]     = {0x07, 0x00, 0x07, 1, 4, 4, 10, 20, 30};
    static const uint8_t NO_LED_KEY[32]  = {0x07, 0x00, 0x07, 2, 0, 1, 1, 1, 1, 9, 9, 1, 1, 1};
    static const uint8_t RGB_COMMIT[32]  = {0x07, 0x00, 0x08};
    send(BEGIN_BLANK);
    send(ONE_KEY);
    frame();
    CHECK(was_painted[led(3, 1)] && painted[led(3, 1)].g == 255, "nothing changes before RGB_COMMIT");
    send(NO_LED_KEY); /* 0,1 has no LED; 9,9 is off the matrix: both ignored */
    send(RGB_COMMIT);
    frame();
    CHECK(painted[led(4, 4)].r == 10 && painted[led(4, 4)].b == 30, "the new key");
    CHECK(was_painted[led(3, 1)] && painted[led(3, 1)].g == 0 && painted[led(3, 1)].b == 0, "others blanked");

    /* An empty set clears everything. */
    static const uint8_t BEGIN_PLAIN[32] = {0x07, 0x00, 0x06, 0x00};
    send(BEGIN_PLAIN);
    send(RGB_COMMIT);
    frame();
    n = 0;
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) n += was_painted[i];
    CHECK(n == 0, "cleared (%d LEDs still painted)", n);
}

/* Colour of LED `i` in the next frame (identity hsv_to_rgb: r = h, g = s, b = v), or -1 if unlit. */
static int frame_at(uint8_t i, char channel) {
    frame();
    if (!was_painted[i]) return -1;
    return channel == 'h' ? painted[i].r : channel == 's' ? painted[i].g : painted[i].b;
}

static void test_animated_colours(void) {
    for (size_t i = 0; i < sizeof FIXTURE_RGB_PACKETS / sizeof FIXTURE_RGB_PACKETS[0]; i++) send(FIXTURE_RGB_PACKETS[i]);
    uint8_t breathe = led(1, 5), cycle = led(1, 6), reactive = led(1, 7);

    /* Breathing (speed 128: a 3.44 s period): dim at the start, full half way, dim again. */
    now = 1000000; /* a multiple of the period's ms is not needed: compare within one period */
    int lo = 255, hi = 0;
    for (int t = 0; t < 3440; t += 40) {
        now = 1000000 + t;
        int v = frame_at(breathe, 'v');
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    CHECK(frame_at(breathe, 'h') == 10, "breathing keeps its hue");
    CHECK(hi >= 190 && hi <= 200, "breathes up to the key's own brightness (%d)", hi);
    CHECK(lo > 0 && lo < 50, "and down to a glow, never off (%d)", lo);

    /* Hue cycle (speed 128: 6.88 s round the wheel): the hue moves from the key's own. */
    now        = 2000000 - 2000000 % 6880;
    int h0     = frame_at(cycle, 'h');
    now       += 6880 / 4;
    int h1     = frame_at(cycle, 'h');
    CHECK(h0 == 20, "the cycle starts at the key's colour (%d)", h0);
    CHECK(h1 >= 20 + 60 && h1 <= 20 + 68, "a quarter of the way round a quarter period later (%d)", h1);
    CHECK(frame_at(cycle, 'v') == 200, "cycling keeps the brightness");

    /* Light on keypress: dark at rest, lit when pressed, fades out (speed 128: 1.1 s). */
    CHECK(frame_at(reactive, 'v') == -1, "unlit until pressed");
    keyrecord_t rec = {.event = {.key = {.col = 7, .row = 1}, .pressed = true}};
    pre_process_record_kb(lookup(2, 1, 7), &rec);
    CHECK(frame_at(reactive, 'v') == 200, "full brightness when pressed");
    now += 552;
    int half = frame_at(reactive, 'v');
    CHECK(half > 80 && half < 120, "half way through the fade (%d)", half);
    now += 600;
    CHECK(frame_at(reactive, 'v') == -1, "gone once faded");
    keyrecord_t knob = {.event = {.key = {.col = 0, .row = KEYLOC_ENCODER_CW}, .pressed = true}};
    pre_process_record_kb(lookup(2, KEYLOC_ENCODER_CW, 0), &knob); /* no LED: nothing to note */

    /* Still keys are unaffected by all this. */
    CHECK(frame_at(led(3, 1), 'v') == 255, "a still key stays put");

    static const uint8_t BEGIN_PLAIN[32] = {0x07, 0x00, 0x06, 0x00}, RGB_COMMIT[32] = {0x07, 0x00, 0x08};
    static const uint8_t BAD_ANIM[32]    = {0x07, 0x00, 0x0C, 1, 1, 5, 1, 2, 3, 9, 50}; /* unknown animation */
    send(BEGIN_PLAIN);
    send(BAD_ANIM);
    send(RGB_COMMIT);
    CHECK(frame_at(breathe, 'v') == 3, "an unknown animation shows the colour still");
    send(BEGIN_PLAIN);
    send(RGB_COMMIT);
}

static void test_lighting_survives_keychrons_reload(void) {
    /* The bug, reproduced: Solid Color + cyan set the VIA way is reloaded to the saved red. */
    rgb_matrix_mode_noeeprom(RGB_MATRIX_SOLID_COLOR);
    rgb_matrix_sethsv_noeeprom(132, 255, 200);
    frames(3);
    CHECK(rgb_matrix_config.hsv.h == 0, "model check: Keychron's reload turns plain VIA colour red (hue %d)", rgb_matrix_config.hsv.h);

    /* Through the module: effect Cycle Left Right, cyan, brightness 255 (→ 200), speed 40. */
    /* Built by the app (fixture.h): Cycle Left Right, hue 132, sat 255, brightness 255, speed 40. */
    uint8_t wave[32];
    memcpy(wave, FIXTURE_LIGHTING, 32);
    uint8_t solid[32] = {0x07, 0x00, 0x09, RGB_MATRIX_SOLID_COLOR, 170, 200, 128, 90};
    send(wave);
    CHECK(reply[0] == 0x07, "lighting packet handled");
    frames(10);
    CHECK(rgb_matrix_config.mode == RGB_MATRIX_CYCLE_LEFT_RIGHT, "effect set");
    CHECK(rgb_matrix_config.hsv.h == 132 && rgb_matrix_config.hsv.s == 255, "colour kept (hue %d)", rgb_matrix_config.hsv.h);
    CHECK(rgb_matrix_config.hsv.v == 200 && rgb_matrix_config.speed == 40, "brightness scaled like VIA, speed kept");

    for (int i = 0; i < 3; i++) { /* back and forth between two profiles */
        send(solid);
        frames(10);
        CHECK(rgb_matrix_config.hsv.h == 170 && rgb_matrix_config.hsv.v == 100 && rgb_matrix_config.speed == 90, "solid profile keeps its colour (round %d, hue %d)", i, rgb_matrix_config.hsv.h);
        send(wave);
        frames(10);
        CHECK(rgb_matrix_config.hsv.h == 132, "wave profile keeps its colour (round %d)", i);
    }

    /* The lighting sleeps (idle timeout) and wakes: Keychron reloads again. */
    asleep = true;
    frames(200);
    asleep = false;
    frames(5);
    CHECK(rgb_matrix_config.hsv.h == 132 && rgb_matrix_config.speed == 40, "after waking up too (hue %d)", rgb_matrix_config.hsv.h);

    /* The user presses a lighting key on the keyboard: the keyboard's own behaviour is back. */
    keyrecord_t rec = {.event = {.key = {.col = 3, .row = 5}, .pressed = true}};
    pre_process_record_kb(RM_HUEU, &rec);
    rgb_matrix_mode_noeeprom(RGB_MATRIX_SOLID_COLOR);
    frames(5);
    CHECK(rgb_matrix_config.hsv.h == EEPROM_HSV.h, "Fn lighting keys hand control back to the keyboard");
    send(wave); /* and the next profile switch takes it again */
    frames(5);
    CHECK(rgb_matrix_config.hsv.h == 132, "until the app sends lighting again");
}

static void test_pixel_rain_starts_from_black(void) {
    static const uint8_t RGB_CLEAR[32] = {0x07, 0x00, 0x06, 0x00}, RGB_COMMIT[32] = {0x07, 0x00, 0x08};
    send(RGB_CLEAR);
    send(RGB_COMMIT);
    frames(2);
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) rgb_matrix_set_color(i, 9, 9, 9); /* the wave's last frame */
    uint8_t rain[32] = {0x07, 0x00, 0x09, RGB_MATRIX_PIXEL_RAIN, 0, 255, 255, 128};
    send(rain);
    keychron_frame();
    int lit = 0;
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) lit += painted[i].r || painted[i].g || painted[i].b;
    CHECK(lit == 0, "Pixel Rain starts on a black board, not a frozen frame (%d LEDs left lit)", lit);
    for (int i = 0; i < RGB_MATRIX_LED_COUNT; i++) rgb_matrix_set_color(i, 9, 9, 9);
    frames(3);
    CHECK(painted[0].r == 9, "…and only when it starts: later frames aren't wiped");
}

static void test_restarts_into_the_bootloader(void) {
    static const uint8_t WRONG[32] = {0x07, 0x00, 0x0E, 'B', 'O', 'O', 'X'};
    static const uint8_t BOOT[32]  = {0x07, 0x00, 0x0E, 'B', 'O', 'O', 'T'};
    send(WRONG);
    run_for(100);
    CHECK(resets == 0, "no magic word: nothing happens");
    send(BOOT);
    CHECK(reply[0] == 0x07 && resets == 0, "answers first");
    run_for(100);
    CHECK(resets == 1, "then restarts into the bootloader (%d)", resets);
}

/* What the module sent to the host on its own (key reports). */
static uint8_t sent[16][32];
static int     sent_count;
static void record_sent(uint8_t *data, uint8_t length) {
    CHECK(length == 32, "raw HID reports are 32 bytes (%d)", length);
    if (sent_count < 16) memcpy(sent[sent_count], data, 32);
    sent_count++;
}
#ifdef LK_WIRELESS_ENABLE
/* A Keychron wireless board: raw_hid_send follows the mode switch to Bluetooth / 2.4 GHz, while the
 * app listens on USB. Key reports must go to the USB driver. */
static int over_the_air;
void raw_hid_send(uint8_t *data, uint8_t length) {
    over_the_air++;
}
host_driver_t chibios_driver = {.send_raw_hid = record_sent};
#else
void raw_hid_send(uint8_t *data, uint8_t length) {
    record_sent(data, length);
}
#endif
static uint32_t idle_cb(uint32_t trigger_time, void *cb_arg) {
    return 1000;
}
#define KEY_REPORT_ON FIXTURE_KEY_REPORT_ON /* what the app sends */
#define KEY_REPORT_OFF FIXTURE_KEY_REPORT_OFF
static void encoder_event(uint8_t index, bool clockwise, bool pressed) {
    keyrecord_t rec = {.event = {.key = {.col = index, .row = clockwise ? KEYLOC_ENCODER_CW : KEYLOC_ENCODER_CCW}, .pressed = pressed}};
    pre_process_record_kb(KC_NO, &rec);
}

static void test_key_reports(void) {
    send_fixture(); /* 2,2 plays a macro */
    run_for(50);
    sent_count = 0;
    int before = pending_callbacks();
    key_event(3, 1, true);
    key_event(3, 1, false);
    run_for(20);
    CHECK(sent_count == 0, "nothing is reported until the app asks (%d)", sent_count);

    send(KEY_REPORT_ON);
    CHECK(reply[0] == 0x07, "KEY_REPORT is handled");
    CHECK(reply[3] == 1, "the reply says it is reporting");
    CHECK(pending_callbacks() == before + 1, "one task sends the reports");
    key_event(3, 1, true);
    CHECK(sent_count == 0, "never sent from the key-event hook itself");
    key_event(2, 2, true); /* a macro key: consumed, but still a key the tester shows */
    encoder_event(0, true, true);
    encoder_event(0, true, false);
    key_event(3, 1, false);
    run_for(PS_KEY_FLUSH_MS);
    CHECK(sent_count == 1, "the queued events go in one report (%d)", sent_count);
    static const uint8_t want[32] = {PS_KEY_REPORT_ID, 5, 0, 3, 1, 1, 2, 2, 1, KEYLOC_ENCODER_CW, 0, 1, KEYLOC_ENCODER_CW, 0, 0, 3, 1, 0};
    CHECK(memcmp(sent[0], want, 32) == 0, "report: %02X %d %d | %d,%d,%d …", sent[0][0], sent[0][1], sent[0][2], sent[0][3], sent[0][4], sent[0][5]);
    run_for(50);
    CHECK(sent_count == 1, "nothing more to say, nothing sent");
    key_event(2, 2, false);
    run_for(30);

    /* A burst bigger than the queue: the rest are dropped and counted, nothing waits. */
    sent_count = 0;
    for (int i = 0; i < 40; i++) key_event(0, (uint8_t)(i % MATRIX_COLS), i % 2 == 0);
    run_for(PS_KEY_FLUSH_MS * 10);
    int delivered = 0;
    for (int i = 0; i < sent_count && i < 16; i++) delivered += sent[i][1];
    CHECK(sent_count == 4 && delivered == PS_KEY_QUEUE, "%d events in %d reports, want %d in 4", delivered, sent_count, PS_KEY_QUEUE);
    CHECK(sent[0][1] == PS_KEYS_PER_REPORT && sent[0][2] == 40 - PS_KEY_QUEUE, "first report full and counts the %d dropped (%d, %d)", 40 - PS_KEY_QUEUE,
          sent[0][1], sent[0][2]);
    CHECK(sent[1][2] == 0, "the count starts again after it was sent");
    const uint8_t *last = &sent[3][3 + (sent[3][1] - 1) * 3];
    CHECK(last[0] == 0 && last[1] == (PS_KEY_QUEUE - 1) % MATRIX_COLS, "oldest first: the last kept is event %d (col %d)", PS_KEY_QUEUE - 1, last[1]);

    /* Renewed in time it keeps going; left alone it stops by itself. */
    run_for(PS_KEY_REPORT_TIMEOUT_MS - 1000);
    send(KEY_REPORT_ON);
    CHECK(pending_callbacks() == before + 1, "a renewal keeps the one task, it doesn't start another (%d)", pending_callbacks() - before);
    run_for(PS_KEY_REPORT_TIMEOUT_MS - 1000);
    sent_count = 0;
    key_event(3, 1, true);
    run_for(PS_KEY_FLUSH_MS);
    CHECK(sent_count == 1, "renewed: still reporting");
    run_for(1100);
    CHECK(pending_callbacks() == before, "not renewed for %d ms: the task is gone", PS_KEY_REPORT_TIMEOUT_MS);
    sent_count = 0;
    key_event(3, 1, false);
    run_for(20);
    CHECK(sent_count == 0, "and nothing is reported any more");

    /* Off at once on request; on again starts with an empty queue. */
    send(KEY_REPORT_ON);
    key_event(3, 1, true);
    send(KEY_REPORT_OFF);
    CHECK(pending_callbacks() == before, "off: the task is cancelled");
    run_for(20);
    CHECK(sent_count == 0, "and what was queued is dropped (%d)", sent_count);
    send(KEY_REPORT_ON);
    run_for(20);
    CHECK(sent_count == 0, "on again: nothing old comes out");
    send(KEY_REPORT_OFF);
    CHECK(reply[3] == 0, "the reply to off says it isn't reporting");
    key_event(3, 1, false);

    /* Every deferred-exec slot taken (a keymap of the user's): it can't start, and says so. */
    deferred_token taken[8];
    int            n_taken = 0;
    while (n_taken < 8 && (taken[n_taken] = defer_exec(1000, idle_cb, NULL)) != INVALID_DEFERRED_TOKEN) n_taken++;
    send(KEY_REPORT_ON);
    CHECK(reply[0] == 0x07 && reply[3] == 0, "no free slot: the reply says it isn't reporting (%d)", reply[3]);
    for (int i = 0; i < n_taken; i++) cancel_deferred_exec(taken[i]);
    send(KEY_REPORT_ON);
    CHECK(reply[3] == 1, "and it starts once a slot is free");
    send(KEY_REPORT_OFF);
#ifdef LK_WIRELESS_ENABLE
    CHECK(over_the_air == 0, "nothing went through raw_hid_send (%d reports)", over_the_air);
#endif
}

static void test_rejects_what_it_does_not_own(void) {
    uint8_t other[32] = {0x07, 0x05, 0x01};
    send(other);
    CHECK(reply[0] == 0xFF, "unknown channel -> unhandled");
    uint8_t bad[32] = {0x07, 0x00, 0x04, 0x07, 0xFF, 26}; /* macro data past the buffer end */
    send(bad);
    CHECK(reply[0] == 0x07, "bad offset is ignored, not a crash");
    uint8_t oob[32] = {0x07, 0x00, 0x0A, 2, 1, 200, 3, 0x00, 0x04}; /* row out of range */
    send(oob);
    CHECK(reply[0] == 0x07, "out-of-range key is ignored");
    /* A count past what a packet holds: only the packet's own 6 entries are read (the rest of the
     * buffer, and whatever follows it, is never touched). */
    uint8_t many[32] = {0x07, 0x00, 0x0A, 2, 255};
    for (int i = 0; i < 6; i++) {
        many[5 + i * 4] = 200; /* out of range: nothing staged, but each entry is read */
        many[6 + i * 4] = 0;
    }
    send(many);
    CHECK(reply[0] == 0x07, "a count above the packet's maximum is clamped, not a crash");
    uint8_t old_keys[32] = {0x07, 0x00, 0x02, 1, 3, 1, 0x00, 0x05}; /* KEYS, retired with 1.0 */
    send(BEGIN);
    send(old_keys);
    send(COMMIT_1);
    CHECK(lookup(2, 3, 1) == base(2, 3, 1), "the retired KEYS command does nothing (0x%04X)", lookup(2, 3, 1));
}

int main(void) {
    for (int r = 0; r < MATRIX_ROWS; r++)
        for (int c = 0; c < MATRIX_COLS; c++) g_led_config.matrix_co[r][c] = r * MATRIX_COLS + c;
    g_led_config.matrix_co[0][1] = NO_LED;

    test_starts_transparent();
    test_fixture_applies();

    test_remaps_stay_on_their_layer();
    test_layer_packets();
    test_macro_plays();
    test_keymap_custom_keycodes_are_not_macros();
    test_a_macro_on_another_layer_leaves_the_keymaps_key_alone();
    test_cutting_short_a_macro_releases_every_key_it_holds();
    test_macro_gap_between_key_steps();
    test_stopping_a_macro_mid_tap_releases_the_key();
    test_macro_releases_what_it_held();
    test_fn_layer_macro_plays();
    test_swap_waits_for_idle();
    test_begin_cancels_a_pending_swap();
    test_per_key_colours();
    test_animated_colours();
    test_lighting_survives_keychrons_reload();
    test_pixel_rain_starts_from_black();
    test_restarts_into_the_bootloader();
    test_key_reports();
    test_rejects_what_it_does_not_own();
    if (failures) {
        printf("%d check(s) failed\n", failures);
        return 1;
    }
    printf("firmware host test ok\n");
    return 0;
}
