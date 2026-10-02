import { useEffect, useState } from "react";
import { api } from "../lib/api";

/** Icons asked for so far, by lower-case path (the shell's answer doesn't change while we run). */
const icons = new Map<string, Promise<string | null>>();

function iconFor(path: string): Promise<string | null> {
  const key = path.toLowerCase();
  let icon = icons.get(key);
  if (!icon) {
    icon = api.getProgramIcon(path).catch(() => null);
    icons.set(key, icon);
  }
  return icon;
}

/**
 * The icon Windows shows for a program (or a folder), 16 px, before its name. A rule with no
 * program (a window title only) gets a window glyph, and so does a program Windows has no icon for.
 */
export function ProgramIcon({ path }: { path: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSrc(null);
    if (path.trim()) iconFor(path).then((url) => live && setSrc(url));
    return () => {
      live = false;
    };
  }, [path]);

  return (
    <span className="program-icon" aria-hidden>
      {src ? <img src={src} alt="" draggable={false} /> : <WindowGlyph />}
    </span>
  );
}

function WindowGlyph() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14">
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M1.5 5.5h13" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
