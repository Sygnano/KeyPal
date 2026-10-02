import { DEFAULT_PROFILE_ID, type AppConfig, type Profile, type ProgramMatch, type ProgramRule } from "./types";

/** "C:\\Games\\cs2.exe" → "cs2.exe" */
export function exeName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The focused window, as the engine sees it. */
export interface Focus {
  path: string;
  title: string;
}

const norm = (p: string) => p.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();

/**
 * How well a rule fits a window, null if it doesn't. Same rules as `rule_score` in the Rust
 * engine: a title condition beats a program alone; then exact path > folder > file name.
 */
export function ruleScore(rule: ProgramRule, focus: Focus): number | null {
  const path = rule.path.trim();
  const title = (rule.title ?? "").trim();
  if (!path && !title) return null;
  let program = 0;
  if (path) {
    const by = rule.match ?? "name";
    const hit =
      by === "name"
        ? exeName(path).toLowerCase() === exeName(focus.path).toLowerCase()
        : by === "folder"
          ? norm(focus.path).startsWith(`${norm(path)}\\`)
          : norm(focus.path) === norm(path);
    if (!hit) return null;
    program = by === "name" ? 1 : by === "folder" ? 2 : 3;
  }
  if (!title) return program;
  return focus.title.toLowerCase().includes(title.toLowerCase()) ? program + 4 : null;
}

/** Which profile the engine picks for a window (without forcing): the best rule, first on a tie. */
export function matchProfile(config: AppConfig, focus: Focus | null): Profile {
  const [def, ...custom] = config.profiles;
  let best: [number, Profile] | null = null;
  if (focus) {
    for (const p of custom) {
      const scores = p.programs.map((r) => ruleScore(r, focus)).filter((s): s is number => s !== null);
      if (scores.length && (!best || Math.max(...scores) > best[0])) best = [Math.max(...scores), p];
    }
  }
  return best?.[1] ?? def;
}

export const MATCH_LABELS: Record<ProgramMatch, string> = {
  name: "This program, in any folder",
  path: "Only this exact file",
  folder: "Any program in this folder",
};

/** What the rule shows in the list: a name and a short detail. */
export function ruleLabel(rule: ProgramRule): { name: string; detail: string } {
  const title = rule.title?.trim();
  const by = rule.match ?? "name";
  const name = !rule.path.trim() ? "Any program" : by === "folder" ? `${exeName(rule.path)}\\…` : exeName(rule.path);
  const parts: string[] = [];
  if (rule.path.trim() && by === "path") parts.push("exact path");
  if (title) parts.push(`title has “${title}”`);
  return { name, detail: parts.join(", ") };
}

export function sameRule(a: ProgramRule, b: ProgramRule): boolean {
  return (
    a.path.toLowerCase() === b.path.toLowerCase() &&
    (a.match ?? "name") === (b.match ?? "name") &&
    (a.title ?? "").trim().toLowerCase() === (b.title ?? "").trim().toLowerCase()
  );
}

/** Drops empty optional fields, so the JSON on disk stays like the Rust side writes it. */
export function cleanRule(rule: ProgramRule): ProgramRule {
  const out: ProgramRule = { path: rule.path };
  if (rule.match && rule.match !== "name") out.match = rule.match;
  if (rule.title?.trim()) out.title = rule.title;
  return out;
}

/** Version 1 files: `exes` (paths matched by file name) become `programs`. */
export function migratePrograms(p: Profile & { exes?: string[] }): Profile {
  if (!p.exes && p.programs) return p;
  const { exes = [], ...rest } = p;
  const programs = [...(p.programs ?? [])];
  for (const path of exes) if (!programs.some((r) => r.path.toLowerCase() === path.toLowerCase())) programs.push({ path });
  return { ...rest, programs };
}

export const isDefaultProfile = (p: Profile) => p.id === DEFAULT_PROFILE_ID;
