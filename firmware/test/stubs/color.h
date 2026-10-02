/* quantum/color.h: HSV and RGB. */
#pragma once
#include <stdint.h>
typedef struct {
    uint8_t h, s, v;
} HSV;
typedef struct {
    uint8_t r, g, b;
} RGB;
