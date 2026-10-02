/**
 * Make the webview behave like a desktop app rather than a web page: no browser context menu
 * (the board has its own), no dragging text or images around, and no browser shortcuts such as
 * reload, print or find. Text fields keep their normal right-click and editing keys.
 */
/** The event landed in something the user is typing into, so the app must keep its hands off. */
export const isEditable = (t: EventTarget | null) =>
  t instanceof HTMLElement && (t.isContentEditable || !!t.closest("input, textarea, select, [contenteditable]"));

/** Browser shortcuts that make no sense in the app. Dev builds keep reload for development. */
function isBrowserShortcut(e: KeyboardEvent): boolean {
  const k = e.key.toLowerCase();
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === "F5" || e.key === "F7" || e.key === "F3") return true;
  if (ctrl && ["r", "p", "f", "g", "u", "s", "j", "h", "o"].includes(k)) return true;
  if (ctrl && e.shiftKey && ["i", "c"].includes(k)) return true;
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return true; // history
  return false;
}

export function installAppFeel(): void {
  document.addEventListener("contextmenu", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
  document.addEventListener("dragstart", (e) => {
    if (!isEditable(e.target)) e.preventDefault();
  });
  // Mouse back/forward buttons would navigate the webview.
  document.addEventListener("mouseup", (e) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  });
  if (import.meta.env.PROD) {
    window.addEventListener("keydown", (e) => {
      if (isBrowserShortcut(e)) e.preventDefault();
    });
  }
}
