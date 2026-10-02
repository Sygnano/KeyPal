import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/barlow/400.css";
import "@fontsource/barlow/500.css";
import "@fontsource/barlow/600.css";
import "@fontsource/barlow-condensed/500.css";
import "@fontsource/barlow-condensed/600.css";
import "./styles.css";
import { App } from "./App";
import { api, initApi } from "./lib/api";
import { installAppFeel } from "./lib/appFeel";
import { applyTheme, installTheme } from "./lib/theme";
import { useStore } from "./state/store";

installAppFeel();
installTheme();

// The window's problems go to the app's log file too, so a report can include them.
const logError = (what: string) => api.log("error", what).catch(() => {});
window.addEventListener("error", (e) =>
  logError(`${e.message} (${e.filename}:${e.lineno})`),
);
window.addEventListener("unhandledrejection", (e) =>
  logError(`unhandled: ${String(e.reason)}`),
);
useStore.subscribe((s, prev) => {
  if (s.error && s.error !== prev.error)
    api.log("warn", s.error).catch(() => {});
  if (s.settings.theme !== prev.settings.theme) applyTheme(s.settings.theme);
});

// In the browser (dev:ui) there is no Tauri: swap in the mock before the app renders. It is a
// dynamic import so the mock never ends up in the production bundle.
void initApi().then(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
