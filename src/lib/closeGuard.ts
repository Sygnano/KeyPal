import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { isMock } from "./api";
import { firmwareDirty } from "../state/firmwareStore";
import { checkDirtyNow, useStore } from "../state/store";

/**
 * Closing the window destroys the webview (the app keeps running in the tray).
 * Unapplied edits would be lost, so ask first.
 */
export function useCloseGuard() {
  useEffect(() => {
    if (isMock) {
      const onBeforeUnload = (e: BeforeUnloadEvent) => {
        checkDirtyNow(); // an edit that was undone by hand must not prompt
        if (useStore.getState().dirty || firmwareDirty()) e.preventDefault();
      };
      window.addEventListener("beforeunload", onBeforeUnload);
      return () => window.removeEventListener("beforeunload", onBeforeUnload);
    }
    let unlisten: (() => void) | undefined;
    // StrictMode's first cleanup runs before `onCloseRequested` resolves, when `unlisten` is
    // still undefined: without this flag that handler stayed registered for ever.
    let cancelled = false;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        checkDirtyNow(); // an edit that was undone by hand must not prompt
        const { dirty } = useStore.getState();
        if (!dirty && !firmwareDirty()) return;
        const what = dirty ? "changes to your profiles that were not applied" : "firmware files with unsaved changes";
        const discard = await ask(`You have ${what}. Close and discard them?`, {
          title: "Unapplied changes",
          kind: "warning",
          okLabel: "Discard and close",
          cancelLabel: "Keep editing",
        });
        if (!discard) event.preventDefault();
      })
      .then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
