import { keycodeAt } from "../lib/keyIds";
import { hex, keycodeToString } from "../qmk/keycodes";
import { bindLabel } from "../lib/profiles";
import { useSelectedProfile, useStore } from "../state/store";
import { keyDisplayName } from "./KeyMenu";
import { MacroEditor } from "./MacroEditor";

export function BindDetail() {
  const profile = useSelectedProfile();
  const keyId = useStore((s) => s.selectedKeyId);
  const base = useStore((s) => s.base);
  const openMenu = useStore((s) => s.openMenu);
  const bind = keyId ? profile.binds[keyId] : undefined;

  if (!keyId || !bind) {
    return (
      <section className="panel bind-detail">
        <h2 className="panel-title">Details</h2>
        <p className="empty">
          {keyId
            ? `${keyDisplayName(keyId, keycodeAt(base, keyId))} keeps its normal function in this profile.`
            : "Select a remapped key to see its details or edit a macro."}
        </p>
      </section>
    );
  }

  const from = keyDisplayName(keyId, keycodeAt(base, keyId));
  const normally = keycodeAt(base, keyId);

  if (bind.kind === "macro") {
    return (
      <section className="panel bind-detail">
        <MacroEditor key={keyId} keyId={keyId} from={from} macro={bind} />
      </section>
    );
  }

  return (
    <section className="panel bind-detail">
      <h2 className="panel-title">
        {from} <span className="muted">sends</span> {bindLabel(bind)}
      </h2>
      <dl className="facts">
        <dt>QMK code</dt>
        <dd className="mono">{bind.kind === "qmk" ? bind.source : keycodeToString(bind.keycode)}</dd>
        <dt>Value</dt>
        <dd className="mono">{hex(bind.keycode)}</dd>
        <dt>Normally</dt>
        <dd>{normally !== undefined ? keycodeToString(normally) : "—"}</dd>
      </dl>
      <button className="btn btn-ghost" onClick={() => openMenu(keyId)}>
        Change
      </button>
    </section>
  );
}
