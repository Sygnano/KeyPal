/* Just enough of QMK to run profile_switcher.c on a PC. The test (host_test.c) defines the
 * functions; values match quantum/ where they matter (keycodes, VIA ids). */
#pragma once
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#define VIA_ENABLE
#define DEFERRED_EXEC_ENABLE
#define ENCODER_MAP_ENABLE
#define MATRIX_ROWS 6
#define MATRIX_COLS 21
#define NUM_ENCODERS (sizeof((int[]){0}) / sizeof(int)) /* an expression, like on the real board */

#define KC_NO 0x0000
#define KC_TRNS 0x0001
#define QK_USER 0x7E40
#define KEYLOC_ENCODER_CW 253
#define KEYLOC_ENCODER_CCW 252

enum { id_custom_set_value = 0x07, id_custom_get_value = 0x08, id_custom_save = 0x09, id_unhandled = 0xFF };
enum { id_custom_channel = 0 };

typedef struct {
    uint8_t col;
    uint8_t row;
} keypos_t;
typedef struct {
    struct {
        keypos_t key;
        bool     pressed;
    } event;
} keyrecord_t;
typedef uint32_t layer_state_t;
typedef uint32_t matrix_row_t;

extern layer_state_t default_layer_state;
static inline uint8_t get_highest_layer(layer_state_t s) {
    return s ? 31 - __builtin_clz(s) : 0;
}

/* action_layer.h / action.h: the layer a key's keycode came from (the test decides). */
extern bool disable_action_cache;
uint8_t     read_source_layers_cache(keypos_t key);
uint8_t     layer_switch_get_layer(keypos_t key);

matrix_row_t matrix_get_row(uint8_t row);
uint16_t     keycode_at_keymap_location(uint8_t layer, uint8_t row, uint8_t col);
uint16_t     keycode_at_encodermap_location(uint8_t layer, uint8_t idx, bool clockwise);
bool         pre_process_record_user(uint16_t keycode, keyrecord_t *record);
void         register_code16(uint16_t kc);
void         unregister_code16(uint16_t kc);
void         tap_code16(uint16_t kc);
void         reset_keyboard(void);
/* raw_hid.h: keyboard -> host. There is no EEPROM API here at all: a module that wrote to EEPROM
 * wouldn't build against these stand-ins. */
void raw_hid_send(uint8_t *data, uint8_t length);
/* host_driver.h, the part the module uses on Keychron's wireless boards (LK_WIRELESS_ENABLE). */
typedef struct {
    void (*send_raw_hid)(uint8_t *, uint8_t);
} host_driver_t;

typedef uint8_t deferred_token;
#define INVALID_DEFERRED_TOKEN 0
typedef uint32_t (*deferred_exec_callback)(uint32_t trigger_time, void *cb_arg);
deferred_token defer_exec(uint32_t delay_ms, deferred_exec_callback callback, void *cb_arg);
bool           cancel_deferred_exec(deferred_token token);

#define NO_LED 255
typedef struct {
    uint8_t matrix_co[MATRIX_ROWS][MATRIX_COLS];
} led_config_t;
extern led_config_t g_led_config;
uint32_t timer_read32(void);
#define TIMER_DIFF_32(a, b) ((uint32_t)((a) - (b)))

#ifdef PS_TEST_WHITE
/* A white backlight (LED matrix): one brightness per LED, laid out like the RGB one below. */
#    define LED_MATRIX_ENABLE
#    define LED_MATRIX_LED_COUNT (MATRIX_ROWS * MATRIX_COLS)
uint8_t led_matrix_get_val(void);
void    led_matrix_set_value(int index, uint8_t value);
bool    led_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max);
bool    led_matrix_indicators_advanced_kb(uint8_t led_min, uint8_t led_max);
#else
/* RGB matrix: an identity "hsv_to_rgb" (r=h, g=s, b=v) so tests can read back exactly what was
 * painted. LED i sits under matrix position i (row*MATRIX_COLS+col), except 0,1, which has none.
 * Like QMK, the RGB matrix brings HSV in (color.h); a white-only board has to include it itself. */
#include "color.h"
#define RGB_MATRIX_ENABLE
#define RGB_MATRIX_LED_COUNT (MATRIX_ROWS * MATRIX_COLS)
RGB     hsv_to_rgb(HSV hsv);
uint8_t rgb_matrix_get_val(void);
void    rgb_matrix_set_color(int index, uint8_t r, uint8_t g, uint8_t b);
bool    rgb_matrix_indicators_advanced_user(uint8_t led_min, uint8_t led_max);

/* Global RGB matrix state and the calls lighting_set/lighting_keep make. */
#define RGB_MATRIX_MAXIMUM_BRIGHTNESS 200
#define ENABLE_RGB_MATRIX_PIXEL_RAIN
enum { RGB_MATRIX_SOLID_COLOR = 1, RGB_MATRIX_CYCLE_LEFT_RIGHT = 5, RGB_MATRIX_PIXEL_RAIN = 37 };
typedef union {
    struct {
        uint8_t enable : 2;
        uint8_t mode : 6;
        HSV     hsv;
        uint8_t speed;
    };
} rgb_config_t;
extern rgb_config_t rgb_matrix_config;
uint8_t rgb_matrix_get_mode(void);
void    rgb_matrix_enable_noeeprom(void);
void    rgb_matrix_disable_noeeprom(void);
void    rgb_matrix_mode_noeeprom(uint8_t mode);
void    rgb_matrix_sethsv_noeeprom(uint16_t h, uint8_t s, uint8_t v);
void    rgb_matrix_set_speed_noeeprom(uint8_t speed);
void    rgb_matrix_set_color_all(uint8_t r, uint8_t g, uint8_t b);
/* Real ranges are QK_RGB_MATRIX_ON.. / QK_UNDERGLOW_TOGGLE..; any disjoint range will do here. */
#define RM_HUEU 0x7845
#define IS_RGB_MATRIX_KEYCODE(c) ((c) >= 0x7840 && (c) <= 0x785F)
#define IS_UNDERGLOW_KEYCODE(c) ((c) >= 0x7820 && (c) <= 0x783F)
#endif
