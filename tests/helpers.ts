/**
 * Shared set-up for the store tests: the store runs against the browser mock backend (no
 * `window.__TAURI_INTERNALS__` in Node), with the calls a test cares about swapped out.
 */
import "./v6board";
import { api, initApi } from "../src/lib/api";
import type { AppConfig, Bind, Profile } from "../src/lib/types";
import { useStore } from "../src/state/store";

const pristine = useStore.getState();

/** A fresh store and a fresh mock backend; returns what was saved through it. */
export async function freshStore(config?: AppConfig) {
  await initApi();
  const saved: AppConfig[] = [];
  const listeners: { configChanged?: (c: AppConfig) => void } = {};
  api.loadConfig = async () =>
    structuredClone(
      config ?? { version: 2, profiles: [profile("default", "Default")] },
    );
  api.saveConfig = async (c) => void saved.push(structuredClone(c));
  api.saveSettings = async () => {};
  api.onConfigChanged = async (cb) => {
    listeners.configChanged = cb;
    return () => {};
  };
  useStore.setState(pristine, true);
  await useStore.getState().init();
  return { saved, listeners, store: useStore };
}

export function profile(
  id: string,
  name: string,
  extra: Partial<Profile> = {},
): Profile {
  return { id, name, programs: [], binds: {}, lighting: null, ...extra };
}

export const key = (keycode: number): Bind => ({ kind: "key", keycode });

export const draftProfile = (id: string) =>
  useStore.getState().draft.profiles.find((p) => p.id === id)!;
