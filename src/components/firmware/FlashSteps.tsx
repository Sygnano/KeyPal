import { flashProgress, type KeyboardState } from "../../lib/flashSteps";
import { moduleStatus } from "../../lib/limits";
import { useFirmware } from "../../state/firmwareStore";
import { useStore } from "../../state/store";

/** What the app knows of the keyboard, for the tracker's last step. */
function useKeyboardState(): KeyboardState {
  const engine = useStore((s) => s.engine);
  const scanned = useFirmware(
    (s) => !!s.status?.devices.some((d) => d.kind === "keyboard"),
  );
  const module = moduleStatus(engine);
  if (module === "current") return "ready";
  if (module === "old") return "old";
  return engine.connected || engine.unreachable || scanned ? "back" : "away";
}

/**
 * Where the keyboard is, next to the output in both modes: 1/n getting (or building) the firmware
 * … n/n keyboard ready. `builds`: this mode builds the firmware rather than downloading it.
 */
export function FlashSteps({ builds }: { builds: boolean }) {
  const job = useFirmware((s) => s.job);
  const p = flashProgress({ job, keyboard: useKeyboardState(), builds });
  const pct =
    job?.state === "running" && job.kind === "flash" && job.progress !== null
      ? ` ${Math.round(job.progress * 100)}%`
      : "";

  return (
    <section className="panel fw-steps" aria-label="Keyboard status">
      <h2 className="fw-steps-title">Keyboard status</h2>
      <div className="fw-steps-head" role="status">
        <span className={`check-dot tone-${p.tone}`} aria-hidden>
          {p.tone === "ok"
            ? "✓"
            : p.tone === "bad"
              ? "!"
              : p.tone === "idle"
                ? "•"
                : ""}
        </span>
        <span className="fw-steps-label">{p.label}</span>
        <span className="fw-steps-count">
          {p.count}/{p.labels.length}
        </span>
      </div>
      <ol className="fw-steps-list">
        {p.labels.map((label, i) => (
          <li
            key={label}
            className={`fw-step is-${p.states[i]}`}
            aria-current={p.states[i] === "active" ? "step" : undefined}
          >
            <span className="fw-step-dot" aria-hidden>
              {p.states[i] === "done"
                ? "✓"
                : p.states[i] === "failed"
                  ? "!"
                  : i + 1}
            </span>
            <span>
              {label}
              {p.states[i] === "active" && i === 2 ? pct : ""}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
