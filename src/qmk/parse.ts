import { QK, valueOf } from "./keycodes";

export type ParseResult = { ok: true; value: number } | { ok: false; error: string };

const MOD_CONSTANTS: Record<string, number> = {
  MOD_LCTL: 0x01, MOD_LSFT: 0x02, MOD_LALT: 0x04, MOD_LGUI: 0x08,
  MOD_RCTL: 0x11, MOD_RSFT: 0x12, MOD_RALT: 0x14, MOD_RGUI: 0x18,
  MOD_HYPR: 0x0f, MOD_MEH: 0x07,
};

/** Modifier wrappers: NAME(kc) → 5-bit mod value (bit 4 = right-hand). */
const WRAPPERS: Record<string, number> = {
  LCTL: 0x01, LSFT: 0x02, LALT: 0x04, LGUI: 0x08,
  LOPT: 0x04, LCMD: 0x08, LWIN: 0x08, C: 0x01, S: 0x02, A: 0x04, G: 0x08,
  LCS: 0x03, LCA: 0x05, LCG: 0x09, LSA: 0x06, LSG: 0x0a, LAG: 0x0c,
  LCSG: 0x0b, LCAG: 0x0d, LSAG: 0x0e,
  RCTL: 0x11, RSFT: 0x12, RALT: 0x14, RGUI: 0x18,
  ALGR: 0x14, ROPT: 0x14, RCMD: 0x18, RWIN: 0x18,
  RCA: 0x15, RCS: 0x13, RCG: 0x19, RSA: 0x16, RSG: 0x1a, RAG: 0x1c,
  RCSG: 0x1b, RCAG: 0x1d, RSAG: 0x1e,
  HYPR: 0x0f, MEH: 0x07,
};

/** Mod-tap aliases: NAME_T(kc) → mods. */
const MOD_TAPS: Record<string, number> = {
  LCTL_T: 0x01, LSFT_T: 0x02, LALT_T: 0x04, LGUI_T: 0x08,
  CTL_T: 0x01, SFT_T: 0x02, ALT_T: 0x04, GUI_T: 0x08,
  LOPT_T: 0x04, LCMD_T: 0x08, LWIN_T: 0x08, OPT_T: 0x04, CMD_T: 0x08, WIN_T: 0x08,
  LCS_T: 0x03, LCA_T: 0x05, LCG_T: 0x09, LSA_T: 0x06, LSG_T: 0x0a, LAG_T: 0x0c,
  LCSG_T: 0x0b, LCAG_T: 0x0d, LSAG_T: 0x0e,
  RCTL_T: 0x11, RSFT_T: 0x12, RALT_T: 0x14, RGUI_T: 0x18,
  ROPT_T: 0x14, ALGR_T: 0x14, RCMD_T: 0x18, RWIN_T: 0x18,
  RCS_T: 0x13, RCA_T: 0x15, RCG_T: 0x19, RSA_T: 0x16, RSG_T: 0x1a, RAG_T: 0x1c,
  RCSG_T: 0x1b, RCAG_T: 0x1d, RSAG_T: 0x1e,
  MEH_T: 0x07, HYPR_T: 0x0f,
};

const LAYER_FNS: Record<string, number> = {
  TO: QK.TO, MO: QK.MOMENTARY, DF: QK.DEF_LAYER, TG: QK.TOGGLE_LAYER,
  OSL: QK.ONE_SHOT_LAYER, TT: QK.LAYER_TAP_TOGGLE,
};

type Node = { kind: "ident"; name: string } | { kind: "num"; value: number } | { kind: "call"; name: string; args: Node[] } | { kind: "or"; items: Node[] };

class Parser {
  private pos = 0;
  constructor(private readonly src: string) {}

  parse(): Node {
    const node = this.expr();
    this.skip();
    if (this.pos < this.src.length) throw new Error(`Unexpected "${this.src.slice(this.pos)}"`);
    return node;
  }

  private skip() {
    while (this.pos < this.src.length && /\s/.test(this.src[this.pos])) this.pos++;
  }

  private expr(): Node {
    const items = [this.atom()];
    this.skip();
    while (this.src[this.pos] === "|") {
      this.pos++;
      items.push(this.atom());
      this.skip();
    }
    return items.length === 1 ? items[0] : { kind: "or", items };
  }

  private atom(): Node {
    this.skip();
    const rest = this.src.slice(this.pos);
    const num = /^(0x[0-9a-fA-F]+|\d+)/.exec(rest);
    if (num) {
      this.pos += num[0].length;
      return { kind: "num", value: Number(num[0]) };
    }
    const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (!ident) throw new Error(rest ? `Unexpected "${rest[0]}"` : "Expected a keycode");
    this.pos += ident[0].length;
    const name = ident[0].toUpperCase();
    this.skip();
    if (this.src[this.pos] !== "(") return { kind: "ident", name };
    this.pos++;
    const args: Node[] = [];
    this.skip();
    if (this.src[this.pos] !== ")") {
      for (;;) {
        args.push(this.expr());
        this.skip();
        if (this.src[this.pos] === ",") { this.pos++; continue; }
        break;
      }
    }
    if (this.src[this.pos] !== ")") throw new Error(`Missing ")" after ${name}(`);
    this.pos++;
    return { kind: "call", name, args };
  }
}

function evalMods(node: Node): number {
  if (node.kind === "num") return node.value & 0x1f;
  if (node.kind === "ident") {
    const v = MOD_CONSTANTS[node.name];
    if (v === undefined) throw new Error(`${node.name} is not a MOD_ constant`);
    return v;
  }
  if (node.kind === "or") {
    const vals = node.items.map(evalMods);
    const right = vals.some((v) => v & 0x10);
    if (right && vals.some((v) => !(v & 0x10) && v !== 0)) throw new Error("Cannot mix left and right modifiers");
    return vals.reduce((a, b) => a | b, 0);
  }
  throw new Error("Expected modifiers");
}

/**
 * US-layout shifted aliases from QMK's keymap_us.h (KC_EXLM = LSFT(KC_1)…). They aren't real
 * keycodes, and on an AZERTY PC Shift+1 types "1", not "!", so they're refused with a hint.
 */
const US_SHIFTED: Record<string, string> = {
  KC_TILD: "`", KC_EXLM: "1", KC_AT: "2", KC_HASH: "3", KC_DLR: "4", KC_PERC: "5", KC_CIRC: "6",
  KC_AMPR: "7", KC_ASTR: "8", KC_LPRN: "9", KC_RPRN: "0", KC_UNDS: "-", KC_PLUS: "=",
  KC_LCBR: "[", KC_RCBR: "]", KC_PIPE: "\\", KC_COLN: ";", KC_DQUO: "'", KC_LABK: ",",
  KC_RABK: ".", KC_QUES: "/",
};

function evalKey(node: Node): number {
  switch (node.kind) {
    case "num":
      if (node.value > 0xffff) throw new Error("Keycodes are 16-bit (max 0xFFFF)");
      return node.value;
    case "ident": {
      const v = valueOf(node.name);
      if (v === undefined) {
        const us = US_SHIFTED[node.name.toUpperCase()];
        if (us)
          throw new Error(
            `${node.name} is a US-layout alias (Shift + the US "${us}" key); on AZERTY it types something else. Pick the key from "Other key", or write LSFT(…) of the AZERTY key.`,
          );
        throw new Error(`Unknown keycode ${node.name}`);
      }
      return v;
    }
    case "or":
      return node.items.map(evalKey).reduce((a, b) => a | b, 0);
    case "call":
      return evalCall(node.name, node.args);
  }
}

function basicArg(node: Node, fn: string): number {
  const kc = evalKey(node);
  if (kc > 0xff) throw new Error(`${fn}() only accepts basic keycodes`);
  return kc;
}

function layerArg(node: Node, max: number): number {
  if (node.kind !== "num") throw new Error("Layer must be a number");
  if (node.value > max) throw new Error(`Layer must be 0–${max}`);
  return node.value;
}

function expectArgs(name: string, args: Node[], n: number) {
  if (args.length !== n) throw new Error(`${name}() takes ${n} argument${n > 1 ? "s" : ""}`);
}

function evalCall(name: string, args: Node[]): number {
  if (name in WRAPPERS) {
    expectArgs(name, args, 1);
    const mods = WRAPPERS[name];
    const inner = evalKey(args[0]);
    if (inner > QK.MODS_MAX) throw new Error(`${name}() needs a basic or modified keycode`);
    const innerMods = (inner >> 8) & 0x1f;
    if (innerMods && (innerMods & 0x10) !== (mods & 0x10)) throw new Error("Cannot mix left and right modifiers");
    return ((mods | innerMods) << 8) | (inner & 0xff);
  }
  if (name in MOD_TAPS) {
    expectArgs(name, args, 1);
    return QK.MOD_TAP | (MOD_TAPS[name] << 8) | basicArg(args[0], name);
  }
  if (name in LAYER_FNS) {
    expectArgs(name, args, 1);
    return LAYER_FNS[name] | layerArg(args[0], 31);
  }
  switch (name) {
    case "MT":
      expectArgs(name, args, 2);
      return QK.MOD_TAP | (evalMods(args[0]) << 8) | basicArg(args[1], name);
    case "LT":
      expectArgs(name, args, 2);
      return QK.LAYER_TAP | (layerArg(args[0], 15) << 8) | basicArg(args[1], name);
    case "LM":
      expectArgs(name, args, 2);
      return QK.LAYER_MOD | (layerArg(args[0], 15) << 5) | evalMods(args[1]);
    case "OSM":
      expectArgs(name, args, 1);
      return QK.ONE_SHOT_MOD | evalMods(args[0]);
  }
  throw new Error(`Unknown function ${name}()`);
}

export function parseKeycode(src: string): ParseResult {
  const trimmed = src.trim();
  if (!trimmed) return { ok: false, error: "Type a keycode, e.g. KC_F13 or LCTL(KC_C)" };
  try {
    return { ok: true, value: evalKey(new Parser(trimmed).parse()) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
