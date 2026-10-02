import type { Theme } from "./types";

/**
 * Light or dark: `data-theme` on <html>, which the CSS reads. "system" follows Windows (and
 * changes with it). The choice lives in settings.json; a copy in localStorage paints the first
 * frame right, before the settings have loaded.
 */
const KEY = "v6ps-theme";
let choice: Theme = "system";

const systemLight = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: light)").matches;

function paint() {
  const light = choice === "light" || (choice === "system" && systemLight());
  document.documentElement.dataset.theme = light ? "light" : "dark";
}

export function applyTheme(theme: Theme) {
  choice = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Private mode or blocked storage: only the first frame of the next start is affected.
  }
  paint();
}

/** At start: the last choice, and following Windows while it's "system". */
export function installTheme() {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "light" || saved === "dark" || saved === "system") choice = saved;
  } catch {
    // Keep "system".
  }
  paint();
  if (typeof matchMedia === "function") matchMedia("(prefers-color-scheme: light)").addEventListener("change", paint);
}
