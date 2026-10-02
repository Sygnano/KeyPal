import { useState } from "react";
import { layerInfos, layerName, splitLayer, type LayerInfo } from "../lib/keyIds";
import { useSelectedProfile, useStore } from "../state/store";

/**
 * One tab per layer of the keyboard's keymap. The names are the user's own (double-click to
 * rename, saved on this PC); tags say what the app can tell from the keymap.
 */
export function LayerTabs() {
  const base = useStore((s) => s.base);
  const keyLayer = useStore((s) => s.keyLayer);
  const names = useStore((s) => s.settings.layerNames);
  const profile = useSelectedProfile();
  const { setKeyLayer, renameLayer } = useStore.getState();
  const [editing, setEditing] = useState<number | null>(null);

  const counts = new Map<number, number>();
  for (const id of Object.keys(profile.binds)) {
    const l = splitLayer(id).layer ?? base.layer;
    counts.set(l, (counts.get(l) ?? 0) + 1);
  }

  return (
    <div className="layer-tabs" role="tablist" aria-label="Keyboard layers">
      {layerInfos(base).map((info) => {
        const name = layerName(info.index, names);
        const count = counts.get(info.index) ?? 0;
        return editing === info.index ? (
          <input
            key={info.index}
            className="layer-tab-input"
            autoFocus
            defaultValue={names[String(info.index)] ?? ""}
            placeholder={`Layer ${info.index}`}
            aria-label={`Name of layer ${info.index}`}
            maxLength={24}
            spellCheck={false}
            onFocus={(e) => e.target.select()}
            onBlur={(e) => {
              renameLayer(info.index, e.target.value);
              setEditing(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(null);
            }}
          />
        ) : (
          <button
            key={info.index}
            role="tab"
            aria-selected={keyLayer === info.index}
            className={`layer-tab ${info.empty ? "is-empty" : ""}`}
            title={describe(info, name)}
            onClick={() => setKeyLayer(info.index)}
            onDoubleClick={() => setEditing(info.index)}
          >
            {info.isDefault && <span className="layer-live" aria-label="default layer" />}
            <span className="layer-tab-name">{name}</span>
            {info.isFn && <span className="layer-tag">Fn</span>}
            {info.empty && <span className="layer-tag">empty</span>}
            {count > 0 && <span className="layer-count-badge">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}

function describe(info: LayerInfo, name: string): string {
  const parts = [`${name} (layer ${info.index} of the keyboard's keymap).`];
  if (info.isDefault) parts.push("The keyboard's default layer right now (the Mac/Win switch picks it).");
  if (info.isFn) parts.push("A key turns it on while held (Fn).");
  if (info.empty) parts.push("Every key is transparent: it does what the layer below does, unless remapped here.");
  parts.push("Double-click to rename.");
  return parts.join(" ");
}
