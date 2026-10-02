/* profile_switcher.c on a white-backlight board (LED matrix, no RGB): the per-key layers become
 * brightness, painted in led_matrix_indicators_advanced_kb, or in the _user hook with
 * PS_INDICATORS_USER (boards whose own code defines the _kb one). Replays the app's RGB packets
 * (fixture.h): hue and saturation are ignored, the value is the brightness.
 * Run: firmware/test/run.sh (compiled twice, with and without PS_INDICATORS_USER). */

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

/* ------------------------------------------------------------------ fake keyboard (just enough) */

layer_state_t default_layer_state = 1u << 2;
static uint32_t now;
matrix_row_t matrix_get_row(uint8_t row) {
    return 0;
}
uint16_t keycode_at_keymap_location(uint8_t layer, uint8_t row, uint8_t col) {
    return 0x2000 + row * MATRIX_COLS + col;
}
uint16_t keycode_at_encodermap_location(uint8_t layer, uint8_t idx, bool cw) {
    return 0x3000;
}
bool    disable_action_cache;
uint8_t read_source_layers_cache(keypos_t key) {
    return get_highest_layer(default_layer_state);
}
uint8_t layer_switch_get_layer(keypos_t key) {
    return get_highest_layer(default_layer_state);
}
bool pre_process_record_user(uint16_t keycode, keyrecord_t *record) {
    return true;
}
void register_code16(uint16_t kc) {}
void unregister_code16(uint16_t kc) {}
void tap_code16(uint16_t kc) {}
void reset_keyboard(void) {}
void raw_hid_send(uint8_t *data, uint8_t length) {}
deferred_token defer_exec(uint32_t delay_ms, deferred_exec_callback cb, void *arg) {
    return INVALID_DEFERRED_TOKEN;
}
bool cancel_deferred_exec(deferred_token token) {
    return false;
}
uint32_t timer_read32(void) {
    return now;
}

led_config_t   g_led_config;
static uint8_t global_val = 255;
static uint8_t painted[LED_MATRIX_LED_COUNT];
static bool    was_painted[LED_MATRIX_LED_COUNT];
static int     keymap_hook_calls;
uint8_t led_matrix_get_val(void) {
    return global_val;
}
void led_matrix_set_value(int i, uint8_t v) {
    painted[i]     = v;
    was_painted[i] = true;
}

#ifdef PS_INDICATORS_USER
/* The board's own _kb hook, like Keychron's S1 / C1 Pro White: _user first, then its indicators. */
bool led_matrix_indicators_advanced_kb(uint8_t led_min, uint8_t led_max) {
    if (!led_matrix_indicators_advanced_user(led_min, led_max)) return false;
    keymap_hook_calls++;
    return true;
}
#else
bool led_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max) {
    keymap_hook_calls++;
    return true;
}
#endif

static void frame(void) {
    memset(was_painted, 0, sizeof(was_painted));
    led_matrix_indicators_advanced_kb(0, LED_MATRIX_LED_COUNT);
}
static uint8_t led(uint8_t row, uint8_t col) {
    return g_led_config.matrix_co[row][col];
}

static uint8_t reply[32];
static void send(const uint8_t *packet) {
    memcpy(reply, packet, 32);
    via_custom_value_command_kb(reply, 32);
}

/* ------------------------------------------------------------------ tests */

static void test_status(void) {
    static const uint8_t STATUS[32] = {0x08, 0x00, 0x10};
    send(STATUS);
    CHECK(reply[3] == 1, "protocol 1 (%d)", reply[3]);
    CHECK(reply[11] == 0 && reply[12] == 0 && reply[13] == 0 && reply[14] == 0, "no build id: built by hand, not by the app");
}

static void test_brightness_layers(void) {
    frame();
    int n = 0;
    for (int i = 0; i < LED_MATRIX_LED_COUNT; i++) n += was_painted[i];
    CHECK(n == 0, "nothing painted before any layers arrive");
    CHECK(keymap_hook_calls == 1, "the other indicators hook still runs");

    for (size_t i = 0; i < sizeof FIXTURE_RGB_PACKETS / sizeof FIXTURE_RGB_PACKETS[0]; i++) {
        send(FIXTURE_RGB_PACKETS[i]);
        CHECK(reply[0] == 0x07, "packet %zu handled", i);
    }
    frame();
    CHECK(was_painted[led(3, 1)] && painted[led(3, 1)] == 255, "3,1 full (%d)", painted[led(3, 1)]);
    CHECK(was_painted[led(2, 2)] && painted[led(2, 2)] == 128, "2,2 half (%d)", painted[led(2, 2)]);
    CHECK(!was_painted[led(0, 0)], "keys without a layer keep the effect");

    global_val = 128;
    frame();
    CHECK(painted[led(3, 1)] == 128, "scaled by the global brightness (%d)", painted[led(3, 1)]);
    global_val = 255;

    /* 1,5 breathes (fixture: anim 1): its brightness moves between frames. */
    uint8_t lo = 255, hi = 0;
    for (int t = 0; t < 4000; t += 50) {
        now = t;
        frame();
        uint8_t v = painted[led(1, 5)];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
    }
    CHECK(hi > lo + 100, "breathing moves (%d..%d)", lo, hi);

    /* 1,7 lights on keypress (anim 3): dark at rest, lit after a press. */
    frame();
    CHECK(!was_painted[led(1, 7)], "reactive key dark at rest");
    keyrecord_t rec = {.event = {.key = {.col = 7, .row = 1}, .pressed = true}};
    pre_process_record_kb(0x2000, &rec);
    frame();
    CHECK(was_painted[led(1, 7)] && painted[led(1, 7)] > 150, "lit after a press (%d)", painted[led(1, 7)]);

    /* Blank others (effect "None" with layers is sent as Solid + this flag). */
    static const uint8_t BEGIN_BLANK[32] = {0x07, 0x00, 0x06, 0x01};
    static const uint8_t ONE_KEY[32]     = {0x07, 0x00, 0x07, 1, 4, 4, 0, 0, 30};
    static const uint8_t RGB_COMMIT[32]  = {0x07, 0x00, 0x08};
    send(BEGIN_BLANK);
    send(ONE_KEY);
    send(RGB_COMMIT);
    frame();
    CHECK(painted[led(4, 4)] == 30, "the new key (%d)", painted[led(4, 4)]);
    CHECK(was_painted[led(0, 0)] && painted[led(0, 0)] == 0, "others dark");
}

static void test_no_rgb_lighting_command(void) {
    /* LIGHTING (0x09) is for Keychron's RGB reload; white boards take VIA's LED matrix channel. */
    static const uint8_t LIGHTING[32] = {0x07, 0x00, 0x09, 1, 0, 0, 255, 128};
    send(LIGHTING);
    CHECK(reply[0] == 0x07, "ignored quietly (echoed like any set)");
}

int main(void) {
    for (int r = 0; r < MATRIX_ROWS; r++) {
        for (int c = 0; c < MATRIX_COLS; c++) g_led_config.matrix_co[r][c] = r * MATRIX_COLS + c;
    }
    g_led_config.matrix_co[0][1] = NO_LED;
    test_status();
    test_brightness_layers();
    test_no_rgb_lighting_command();
#ifdef PS_INDICATORS_USER
    const char *hook = "_user hook";
#else
    const char *hook = "_kb hook";
#endif
    if (failures) {
        printf("white backlight (%s): %d check(s) failed\n", hook, failures);
        return 1;
    }
    printf("white backlight (%s): all checks passed\n", hook);
    return 0;
}
