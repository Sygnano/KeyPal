import { boardId, keycodeAt, layerName, layerOf } from "../lib/keyIds";
import { KEYS } from "../lib/layout";
import { bindKindLabel, bindLabel, isDisabled } from "../lib/profiles";
import type { KeyId } from "../lib/types";
import { useSelectedProfile, useStore } from "../state/store";
import { keyDisplayName } from "./KeyMenu";
import { CrossIcon } from "./ProfileList";

/** By layer, then knobs, then in keyboard order (the board shown; keys it lacks last). */
function ranker(defaultLayer: number) {
  const order = new Map(KEYS.map((k, i) => [k.id, i]));
  const place = (key: KeyId) => {
    const knob = /^e(\d+):(ccw|cw)$/.exec(key);
    return knob ? -100 + Number(knob[1]) * 2 + (knob[2] === "cw" ? 1 : 0) : (order.get(key) ?? 999);
  };
  return (id: KeyId) => layerOf(id, defaultLayer) * 1000 + place(boardId(id));
}

export function BindList() {
  const profile = useSelectedProfile();
  const base = useStore((s) => s.base);
  const selectedKeyId = useStore((s) => s.selectedKeyId);
  const names = useStore((s) => s.settings.layerNames);
  const { selectKey, removeBind, setKeyLayer } = useStore.getState();

  const rank = ranker(base.layer);
  const entries = Object.entries(profile.binds).sort(([a], [b]) => rank(a) - rank(b));

  return (
    <section className="panel bind-list" aria-labelledby="bind-list-title">
      <h2 id="bind-list-title" className="panel-title">
        Remapped keys <span className="count">{entries.length}</span>
      </h2>
      {entries.length === 0 ? (
        <p className="empty">Click any key on the keyboard to remap it for {profile.name}.</p>
      ) : (
        <ul className="binds">
          {entries.map(([id, bind]) => {
            const from = keyDisplayName(id, keycodeAt(base, id));
            const layer = layerOf(id, base.layer);
            return (
              <li key={id} className={`bind ${selectedKeyId === id ? "is-selected" : ""}`}>
                <button
                  className="bind-main"
                  onClick={() => {
                    setKeyLayer(layer);
                    selectKey(id);
                  }}
                >
                  <span className="bind-layer" title={`Layer ${layer}`}>
                    {layerName(layer, names)}
                  </span>
                  <span className="bind-from">{from}</span>
                  <span className="bind-arrow" aria-hidden>
                    →
                  </span>
                  <span className={`bind-to tape-inline ${isDisabled(bind) ? "is-off" : ""}`}>{bindLabel(bind)}</span>
                  <span className="bind-kind">{bindKindLabel(bind)}</span>
                </button>
                <button className="icon-btn danger small" aria-label={`Remove remap of ${from}`} onClick={() => removeBind(id)}>
                  <CrossIcon />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
