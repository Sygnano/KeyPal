/**
 * The macro bank (`AppConfig.macros`): named macros any key in any profile can play. Pure
 * functions over the whole config, so an edit that reaches every profile is one draft change (one
 * undo step, one Apply).
 *
 * The invariant: a macro bind with `macroId` always has its entry's `name`, `steps` and `gap`.
 * Binds keep that copy so building the keymap, export and the protocol never need the bank.
 */
import type { AppConfig, BankMacro, Bind, KeyId, MacroStep, Profile } from "./types";

export type MacroBind = Extract<Bind, { kind: "macro" }>;
/** What a macro is, without where it lives. */
export type MacroContent = Pick<BankMacro, "name" | "steps" | "gap">;

/** A key playing a bank macro. */
export interface MacroUse {
  profileId: string;
  profileName: string;
  keyId: KeyId;
}

export const bankOf = (c: AppConfig): BankMacro[] => c.macros ?? [];

export const findMacro = (c: AppConfig, id: string | undefined): BankMacro | undefined =>
  id === undefined ? undefined : bankOf(c).find((m) => m.id === id);

export function newMacroId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id = `m_${Math.random().toString(36).slice(2, 10)}`;
    if (!used.has(id)) return id;
  }
}

/** `name`, or "name 2", "name 3"… : the first one no other entry (but `exceptId`) has. */
export function uniqueName(name: string, bank: BankMacro[], exceptId?: string): string {
  const base = name.trim() || "Macro";
  const taken = new Set(bank.filter((m) => m.id !== exceptId).map((m) => m.name));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** The fields that define a macro, `gap` left out when absent (so JSON comparisons hold). */
function content(m: MacroContent): MacroContent {
  return m.gap === undefined ? { name: m.name, steps: m.steps } : { name: m.name, steps: m.steps, gap: m.gap };
}

export const sameContent = (a: MacroContent, b: MacroContent) =>
  JSON.stringify(content(a)) === JSON.stringify(content(b));

/** The bind that plays `entry`. */
export const bindOf = (entry: BankMacro): MacroBind => ({ kind: "macro", ...content(entry), macroId: entry.id });

const entryOf = (id: string, m: MacroContent): BankMacro => ({ id, ...content(m) });

/** Every key playing this entry, in every profile. */
export function usesOf(c: AppConfig, id: string): MacroUse[] {
  return c.profiles.flatMap((p) =>
    Object.entries(p.binds)
      .filter(([, b]) => b.kind === "macro" && b.macroId === id)
      .map(([keyId]) => ({ profileId: p.id, profileName: p.name, keyId })),
  );
}

/** How many keys play each entry (0 for unused ones). */
export function countUses(c: AppConfig): Map<string, number> {
  const counts = new Map(bankOf(c).map((m) => [m.id, 0]));
  for (const p of c.profiles)
    for (const b of Object.values(p.binds))
      if (b.kind === "macro" && b.macroId !== undefined && counts.has(b.macroId))
        counts.set(b.macroId, counts.get(b.macroId)! + 1);
  return counts;
}

/** Puts `entry` in the bank (replacing the one with its id) and gives every key linked to it its
 * new content, in every profile. */
export function withEntry(c: AppConfig, entry: BankMacro): AppConfig {
  const bank = bankOf(c);
  const macros = bank.some((m) => m.id === entry.id) ? bank.map((m) => (m.id === entry.id ? entry : m)) : [...bank, entry];
  const bind = bindOf(entry);
  return {
    ...c,
    macros,
    profiles: c.profiles.map((p) => {
      if (!Object.values(p.binds).some((b) => b.kind === "macro" && b.macroId === entry.id)) return p;
      const binds = { ...p.binds };
      for (const [k, b] of Object.entries(binds)) if (b.kind === "macro" && b.macroId === entry.id) binds[k] = { ...bind };
      return { ...p, binds };
    }),
  };
}

function setKey(c: AppConfig, profileId: string, keyId: KeyId, bind: Bind): AppConfig {
  return {
    ...c,
    profiles: c.profiles.map((p) => (p.id === profileId ? { ...p, binds: { ...p.binds, [keyId]: bind } } : p)),
  };
}

const bindAt = (c: AppConfig, profileId: string, keyId: KeyId): Bind | undefined =>
  c.profiles.find((p) => p.id === profileId)?.binds[keyId];

/** A new entry with this content (its name made unique), and the key linked to it. `id`: a given
 * one (the load migration's, the same on every load), else a random one. */
export function createMacro(c: AppConfig, profileId: string, keyId: KeyId, m: MacroContent, id?: string): AppConfig {
  const bank = bankOf(c);
  const taken = bank.map((x) => x.id);
  const fresh = id !== undefined && !taken.includes(id) ? id : newMacroId(taken);
  const entry = entryOf(fresh, { ...m, name: uniqueName(m.name, bank) });
  return setKey(withEntry(c, entry), profileId, keyId, bindOf(entry));
}

/**
 * The one way a macro bind is written. With the `macroId` of an entry, the entry takes the bind's
 * content (name kept unique) and every key linked to it follows; with an unknown or no `macroId`,
 * the bind gets an entry of its own.
 */
export function putMacro(c: AppConfig, profileId: string, keyId: KeyId, bind: MacroBind): AppConfig {
  const entry = findMacro(c, bind.macroId);
  if (!entry) {
    // An id the bank doesn't know keeps that id (an entry was deleted under it, or a test made it).
    if (bind.macroId === undefined) return createMacro(c, profileId, keyId, bind);
    const named = entryOf(bind.macroId, { ...bind, name: uniqueName(bind.name, bankOf(c)) });
    return setKey(withEntry(c, named), profileId, keyId, bindOf(named));
  }
  const next = entryOf(entry.id, { ...bind, name: uniqueName(bind.name, bankOf(c), entry.id) });
  return setKey(withEntry(c, next), profileId, keyId, bindOf(next));
}

/** The key plays this entry, linked: an edit made later reaches every key using it. */
export function linkMacro(c: AppConfig, profileId: string, keyId: KeyId, macroId: string): AppConfig {
  const entry = findMacro(c, macroId);
  return entry ? setKey(c, profileId, keyId, bindOf(entry)) : c;
}

/** The key gets a copy of this entry, "<name> (copy)", to edit on its own. */
export function copyMacro(c: AppConfig, profileId: string, keyId: KeyId, macroId: string): AppConfig {
  const entry = findMacro(c, macroId);
  return entry ? createMacro(c, profileId, keyId, { ...entry, name: `${entry.name} (copy)` }) : c;
}

/** This key alone gets an entry of its own (same content, a new name); the others keep the old one. */
export function unlinkMacro(c: AppConfig, profileId: string, keyId: KeyId): AppConfig {
  const bind = bindAt(c, profileId, keyId);
  if (bind?.kind !== "macro") return c;
  return createMacro(c, profileId, keyId, bind);
}

/** Removes an entry no key uses; one in use stays (null says why it can't go). */
export function deleteMacro(c: AppConfig, macroId: string): AppConfig | null {
  if (usesOf(c, macroId).length) return null;
  const bank = bankOf(c).filter((m) => m.id !== macroId);
  const { macros: _old, ...rest } = c;
  return bank.length ? { ...rest, macros: bank } : rest;
}

/**
 * On load: every macro bind without an entry gets one, one per bind, never merged by content (two
 * keys that happen to play the same steps stay independent, as they were). A bind whose `macroId`
 * names an entry takes that entry's content back if they differ.
 */
export function migrateMacroBank(c: AppConfig): AppConfig {
  let out = c;
  for (const p of c.profiles) {
    for (const [keyId, b] of Object.entries(p.binds)) {
      if (b.kind !== "macro") continue;
      const entry = findMacro(out, b.macroId);
      // The same file gets the same ids on every load, so loading twice compares equal.
      if (!entry && b.macroId === undefined) out = createMacro(out, p.id, keyId, b, `m_${hash(`${p.id}/${keyId}`)}`);
      else if (!entry) out = putMacro(out, p.id, keyId, b);
      else if (!sameContent(entry, b)) out = setKey(out, p.id, keyId, bindOf(entry));
    }
  }
  return out;
}

/**
 * Imported profiles join `c`'s bank: an id the bank doesn't have becomes an entry (from the
 * imported binds' content); an id it has with the same content stays linked; an id it has with
 * different content gets a new id, on every imported bind that carried it. Binds without an id get
 * an entry each. Returns the bank and the profiles to add.
 */
export function mergeImported(c: AppConfig, incoming: Profile[]): { macros: BankMacro[]; profiles: Profile[] } {
  let bank = bankOf(c);
  // By incoming id *and* content: what one id with one content became, for every bind like it.
  const renamed = new Map<string, BankMacro>();
  const keyOf = (b: MacroBind) => `${b.macroId}|${JSON.stringify(content(b))}`;
  const profiles = incoming.map((p) => {
    const binds = { ...p.binds };
    for (const [keyId, b] of Object.entries(binds)) {
      if (b.kind !== "macro") continue;
      let entry = b.macroId !== undefined ? renamed.get(keyOf(b)) : undefined;
      if (!entry) {
        const existing = findMacro({ ...c, macros: bank }, b.macroId);
        if (existing && sameContent(existing, b)) entry = existing;
        else {
          const taken = bank.map((m) => m.id);
          const id = b.macroId !== undefined && !existing ? b.macroId : newMacroId(taken);
          entry = entryOf(id, { ...b, name: uniqueName(b.name, bank) });
          bank = [...bank, entry];
        }
        if (b.macroId !== undefined) renamed.set(keyOf(b), entry);
      }
      binds[keyId] = bindOf(entry);
    }
    return { ...p, binds };
  });
  return { macros: bank, profiles };
}

/** FNV-1a, base 36. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

/** One line for a macro's steps: "A, ↓Shift, 50 ms, B…" (`label` names a keycode). */
export function stepsPreview(steps: MacroStep[], label: (kc: number) => string, max = 8): string {
  if (!steps.length) return "No steps yet";
  const shown = steps.slice(0, max).map((s) =>
    s.op === "delay" ? `${s.ms} ms` : `${s.op === "down" ? "↓" : s.op === "up" ? "↑" : ""}${label(s.keycode)}`,
  );
  return shown.join(", ") + (steps.length > max ? ` … (${steps.length} steps)` : "");
}
