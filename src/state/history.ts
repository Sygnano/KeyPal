import type { AppConfig } from "../lib/types";

/**
 * Undo/redo of the draft (unapplied edits). Every change to the draft is a step, except that
 * quick successive changes in the same "group" (dragging a slider or the colour wheel, typing a
 * name, painting keys with a box) merge into one.
 */
export interface History {
  past: AppConfig[];
  future: AppConfig[];
  /** Group of the last recorded change and when it happened, for merging. */
  group: string | null;
  at: number;
}

export const HISTORY_LIMIT = 100;
/** Changes in the same group closer together than this are one step. */
export const MERGE_MS = 800;

export const emptyHistory = (): History => ({ past: [], future: [], group: null, at: 0 });

/** The draft changed from `before`: remember it, unless it continues the last change's group. */
export function record(h: History, before: AppConfig, group: string | null, now: number): History {
  if (group !== null && group === h.group && now - h.at < MERGE_MS && h.past.length) {
    return { ...h, future: [], at: now };
  }
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [], group, at: now };
}

/** The draft to go back to, and the history after it; null when there's nothing to undo. */
export function undo(h: History, current: AppConfig): [AppConfig, History] | null {
  const prev = h.past[h.past.length - 1];
  if (!prev) return null;
  return [prev, { past: h.past.slice(0, -1), future: [current, ...h.future], group: null, at: 0 }];
}

export function redo(h: History, current: AppConfig): [AppConfig, History] | null {
  const [next, ...rest] = h.future;
  if (!next) return null;
  return [next, { past: [...h.past, current], future: rest, group: null, at: 0 }];
}
