import * as CM from "@radix-ui/react-context-menu";
import type { ReactNode } from "react";
import { allIds, type BoardMode } from "../lib/board";
import { PRESETS, WHITE_LEVELS, hsvToCss } from "../lib/color";
import { bindId, keycodeAt } from "../lib/keyIds";
import { MIX_RGB, effectiveKeys } from "../lib/layers";
import { BOARD, isEncoderId } from "../lib/layout";
import { DISABLED_BIND, isDisabled } from "../lib/profiles";
import type { KeyId } from "../lib/types";
import { mixRegionLimit, useSelectedProfile, useStore, type MenuTab } from "../state/store";
import { keyDisplayName } from "./KeyMenu";
import { regionName } from "./MixPanel";

/**
 * The app's own right-click menu on the board. `targets` are the keys it acts on: the picked keys
 * when the right-clicked key is one of them, otherwise just that key (set by KeyboardView). Remap
 * actions apply on the layer shown (`layer`).
 */
export function BoardContextMenu(props: { mode: BoardMode; layer: number; targets: KeyId[]; disabled?: boolean; children: ReactNode }) {
  const { mode, layer, targets, disabled, children } = props;
  const profile = useSelectedProfile();
  const base = useStore((s) => s.base);
  const defaultLighting = useStore((s) => s.draft.profiles[0].lighting);
  const savedColours = useStore((s) => s.settings.savedColors);
  const regionLimit = useStore(mixRegionLimit);
  const { setBindMany, removeBinds, setKeyColors, setPicked, openMenu, setTab, addLayer, moveToRegion, addRegion } = useStore.getState();

  const single = targets.length === 1 ? targets[0] : null;
  const binds = targets.map((id) => bindId(id, layer));
  const title = single ? keyDisplayName(bindId(single, layer), keycodeAt(base, bindId(single, layer))) : `${targets.length} keys`;
  const bound = binds.filter((id) => profile.binds[id]);
  const allOff = binds.length > 0 && binds.every((id) => isDisabled(profile.binds[id]));
  const lit = targets.filter((id) => !isEncoderId(id));
  const lighting = profile.lighting ?? defaultLighting;
  // With Mix RGB on, keys go to its regions instead of colour layers.
  const mix = lighting?.effect === MIX_RGB ? lighting.mix : undefined;
  const colours = effectiveKeys(lighting);
  const coloured = lit.filter((id) => colours[id]);

  const remap = (tab: MenuTab) => {
    if (!single) return;
    if (mode !== "keys") setTab("keys");
    // After the context menu has closed and handed focus back.
    setTimeout(() => openMenu(bindId(single, useStore.getState().keyLayer), tab), 0);
  };
  // A layer of their own, on top, whose colour the Colour panel then edits.
  const customColour = () => {
    if (mode !== "lighting") setTab("lighting");
    addLayer(lit, colours[lit[0]] ?? { h: 0, s: 0, v: 255 });
    setTimeout(() => document.getElementById("key-colour-picker")?.scrollIntoView({ block: "nearest" }), 50);
  };

  return (
    <CM.Root>
      <CM.Trigger asChild disabled={disabled}>
        {children}
      </CM.Trigger>
      <CM.Portal>
        <CM.Content className="ctx" collisionPadding={8} loop>
          {targets.length === 0 ? (
            <>
              <CM.Label className="ctx-label">Keyboard</CM.Label>
              <CM.Item className="ctx-item" onSelect={() => setPicked(allIds(mode))}>
                Select all keys <kbd>Ctrl+A</kbd>
              </CM.Item>
            </>
          ) : (
            <>
              <CM.Label className="ctx-label">{title}</CM.Label>

              {single && (
                <>
                  <CM.Item className="ctx-item" onSelect={() => remap("key")}>
                    Remap to another key…
                  </CM.Item>
                  <CM.Item className="ctx-item" onSelect={() => remap("macro")}>
                    Macro…
                  </CM.Item>
                  <CM.Item className="ctx-item" onSelect={() => remap("qmk")}>
                    QMK code…
                  </CM.Item>
                </>
              )}
              {!allOff && (
                <CM.Item className="ctx-item" onSelect={() => setBindMany(binds, DISABLED_BIND)}>
                  {single ? "Disable key" : `Disable ${targets.length} keys`}
                </CM.Item>
              )}
              {bound.length > 0 && (
                <CM.Item className="ctx-item" onSelect={() => removeBinds(bound)}>
                  {single ? "Reset to default" : `Reset ${bound.length} remap${bound.length > 1 ? "s" : ""}`}
                  <kbd>{mode === "keys" ? "Del" : ""}</kbd>
                </CM.Item>
              )}

              {lit.length > 0 && mix && (
                <>
                  <CM.Separator className="ctx-sep" />
                  <CM.Sub>
                    <CM.SubTrigger className="ctx-item">
                      Mix RGB region <span className="ctx-arrow">›</span>
                    </CM.SubTrigger>
                    <CM.Portal>
                      <CM.SubContent className="ctx" collisionPadding={8} sideOffset={4}>
                        {mix.regions.map((_, i) => (
                          <CM.Item key={i} className="ctx-item" onSelect={() => moveToRegion(lit, i)}>
                            {regionName(i)}
                          </CM.Item>
                        ))}
                        {mix.regions.length < regionLimit && (
                          <CM.Item
                            className="ctx-item"
                            onSelect={() => {
                              if (mode !== "lighting") setTab("lighting");
                              addRegion(lit);
                            }}
                          >
                            New layer with {single ? "this key" : "these keys"}
                          </CM.Item>
                        )}
                      </CM.SubContent>
                    </CM.Portal>
                  </CM.Sub>
                </>
              )}
              {lit.length > 0 && BOARD.lighting === "white" && (
                <>
                  <CM.Separator className="ctx-sep" />
                  <CM.Sub>
                    <CM.SubTrigger className="ctx-item">
                      Brightness <span className="ctx-arrow">›</span>
                    </CM.SubTrigger>
                    <CM.Portal>
                      <CM.SubContent className="ctx" collisionPadding={8} sideOffset={4}>
                        {WHITE_LEVELS.map(([name, hsv]) => (
                          <CM.Item key={name} className="ctx-item" onSelect={() => setKeyColors(lit, hsv)}>
                            <span className="ctx-level" style={{ background: hsvToCss(hsv) }} aria-hidden />
                            {name}
                          </CM.Item>
                        ))}
                        <CM.Item className="ctx-item" onSelect={customColour}>
                          Other brightness…
                        </CM.Item>
                        {coloured.length > 0 && (
                          <CM.Item className="ctx-item" onSelect={() => setKeyColors(coloured, null)}>
                            Like the effect <kbd>{mode === "lighting" ? "Del" : ""}</kbd>
                          </CM.Item>
                        )}
                      </CM.SubContent>
                    </CM.Portal>
                  </CM.Sub>
                </>
              )}
              {lit.length > 0 && BOARD.lighting === "rgb" && (
                <>
                  <CM.Separator className="ctx-sep" />
                  <CM.Sub>
                    <CM.SubTrigger className="ctx-item">
                      Colour <span className="ctx-arrow">›</span>
                    </CM.SubTrigger>
                    <CM.Portal>
                      <CM.SubContent className="ctx" collisionPadding={8} sideOffset={4}>
                        <div className="ctx-swatches" role="group" aria-label="Colours">
                          {PRESETS.map(([name, hsv]) => (
                            <CM.Item
                              key={name}
                              className="ctx-swatch"
                              title={name}
                              aria-label={name}
                              style={{ background: hsvToCss(hsv) }}
                              onSelect={() => setKeyColors(lit, hsv)}
                            />
                          ))}
                        </div>
                        {savedColours.length > 0 && (
                          <div className="ctx-swatches is-saved" role="group" aria-label="Saved colours">
                            {savedColours.map((hsv) => (
                              <CM.Item
                                key={`saved:${hsv.h},${hsv.s},${hsv.v}`}
                                className="ctx-swatch"
                                title="Saved colour"
                                aria-label={`Saved colour H ${hsv.h} S ${hsv.s} B ${hsv.v}`}
                                style={{ background: hsvToCss(hsv) }}
                                onSelect={() => setKeyColors(lit, hsv)}
                              />
                            ))}
                          </div>
                        )}
                        <CM.Item className="ctx-item" onSelect={customColour}>
                          Custom colour…
                        </CM.Item>
                        {coloured.length > 0 && (
                          <CM.Item className="ctx-item" onSelect={() => setKeyColors(coloured, null)}>
                            No colour <kbd>{mode === "lighting" ? "Del" : ""}</kbd>
                          </CM.Item>
                        )}
                      </CM.SubContent>
                    </CM.Portal>
                  </CM.Sub>
                </>
              )}

              <CM.Separator className="ctx-sep" />
              <CM.Item className="ctx-item" onSelect={() => setPicked(allIds(mode))}>
                Select all keys <kbd>Ctrl+A</kbd>
              </CM.Item>
              <CM.Item className="ctx-item" onSelect={() => setPicked([])}>
                Clear selection <kbd>Esc</kbd>
              </CM.Item>
            </>
          )}
        </CM.Content>
      </CM.Portal>
    </CM.Root>
  );
}
