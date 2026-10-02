import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

/** How far the pointer moves before a press on a row becomes a drag (a shorter move is a click). */
const THRESHOLD = 5;

export interface DragReorder {
  /** The row being dragged. */
  dragging: string | null;
  /** Where it would land: the index it gets once moved. */
  target: number | null;
  /** Spread on each row's element (it needs `data-reorder-id`). */
  rowProps(id: string): { "data-reorder-id": string; onPointerDown(e: ReactPointerEvent<HTMLElement>): void };
}

/**
 * Drag rows up and down a list to reorder it, with pointer events (the app turns the browser's own
 * drag and drop off). A press on a button, menu or text field (unless `data-drag-ok`) doesn't
 * start one. Rows before `first` stay where they are (Default, pinned at the top).
 */
export function useDragReorder(ids: string[], onMove: (id: string, to: number) => void, first = 0): DragReorder {
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const live = useRef({ ids, onMove, first });
  live.current = { ids, onMove, first };

  const rowProps = (id: string) => ({
    "data-reorder-id": id,
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.button !== 0 || live.current.ids.indexOf(id) < live.current.first) return;
      // Fields marked data-drag-ok (a row's name) still start a drag when the pointer goes up or down.
      if ((e.target as HTMLElement).closest("input:not([data-drag-ok]), textarea, select, button, a, [role=menu]")) return;
      const list = e.currentTarget.parentElement;
      if (!list) return;
      const startY = e.clientY;
      let started = false;
      let to: number | null = null;

      const move = (ev: PointerEvent) => {
        if (!started) {
          if (Math.abs(ev.clientY - startY) < THRESHOLD) return;
          started = true;
          (document.activeElement as HTMLElement | null)?.blur();
          window.getSelection()?.removeAllRanges();
          setDragging(id);
          document.body.classList.add("is-reordering");
        }
        // The index it lands on: rows (other than itself) whose middle is above the pointer.
        const { ids: order, first: min } = live.current;
        const rows = [...list.querySelectorAll<HTMLElement>(":scope > [data-reorder-id]")].filter((r) => r.dataset.reorderId !== id);
        const above = rows.filter((r) => {
          const b = r.getBoundingClientRect();
          return b.top + b.height / 2 < ev.clientY;
        }).length;
        to = Math.max(min, Math.min(order.length - 1, above));
        setTarget(to);
      };
      const end = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        document.body.classList.remove("is-reordering");
        if (!started) return;
        // The click that ends a drag isn't a click on the row. It is swallowed until the next
        // press: a timeout was too short, so a click synthesized late escaped it and selected the
        // row that had just been dropped.
        const done = () => {
          window.removeEventListener("click", swallow, true);
          window.removeEventListener("pointerdown", done, true);
        };
        const swallow = (c: MouseEvent) => {
          c.stopPropagation();
          c.preventDefault();
          done();
        };
        window.addEventListener("click", swallow, true);
        window.addEventListener("pointerdown", done, true);
        setDragging(null);
        setTarget(null);
        if (to !== null && to !== live.current.ids.indexOf(id)) live.current.onMove(id, to);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
  });

  return { dragging, target, rowProps };
}

/** The class a row gets while another is dragged over it: a line above or below it. */
export function dropClass(d: DragReorder, ids: string[], id: string): string {
  if (d.dragging === null || d.target === null) return "";
  if (id === d.dragging) return "is-dragging";
  const from = ids.indexOf(d.dragging);
  const at = ids.indexOf(id);
  if (d.target === from) return "";
  // Moving down, it lands after the row at `target`; moving up, before it.
  if (d.target > from) return at === d.target ? "drop-after" : "";
  return at === d.target ? "drop-before" : "";
}
