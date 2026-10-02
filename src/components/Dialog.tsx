import { useEffect, useRef, type ReactNode } from "react";
import { CrossIcon } from "./ProfileList";

/** Elements a Tab can land on inside the dialog. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** A modal panel over the app. Esc or a click outside closes it; Tab stays inside it. */
export function Dialog(props: { title: string; onClose(): void; children: ReactNode; wide?: boolean }) {
  const { title, onClose, children, wide } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    // Focus the dialog so Tab starts inside it and a screen reader announces it.
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // A text field's own Escape (clearing a suggestion list, cancelling an edit in place)
        // comes first: closing the whole dialog on it loses everything the user typed.
        const t = e.target;
        const editing = t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable]");
        if (editing && !e.defaultPrevented) {
          (t as HTMLElement).blur();
          e.stopPropagation();
          return;
        }
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      // Trap: without this, Tab walks out of the modal and into the app behind it.
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const [head, tail] = [items[0], items[items.length - 1]];
      const here = document.activeElement;
      if (!e.shiftKey && (here === tail || !dialog.contains(here))) {
        head.focus();
        e.preventDefault();
      } else if (e.shiftKey && (here === head || !dialog.contains(here))) {
        tail.focus();
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`dialog ${wide ? "is-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="dialog-head">
          <h2 className="panel-title">{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <CrossIcon />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>
  );
}
