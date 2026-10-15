/**
 * Which open overlay owns the keyboard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS: A CONFIRMATION OPENS ON TOP OF SOMETHING.
 *
 * `Modal` and `Drawer` each listen for Escape and Tab on `document`, in the
 * capture phase. With one overlay open that is exactly right. With two — the
 * member drawer under an Edit dialog, the walk-in sale under its "Charge
 * ₱90?" confirmation — BOTH listeners fire on every key: Escape in the
 * confirmation also closed the sale underneath it, and the lower overlay's
 * Tab trap fought the upper one's. `stopPropagation` cannot help, because
 * the two listeners sit on the same node.
 *
 * So every overlay registers here when it opens and only the most recent one
 * answers the keyboard. Registration happens on OPEN, not on every render: a
 * parent re-rendering with a new `onClose` must not jump back above the
 * dialog that opened over it.
 * ─────────────────────────────────────────────────────────────────────────
 */

const stack: symbol[] = [];

/** Registers a newly opened overlay as the top one. */
export function pushOverlay(): symbol {
  const id = Symbol('overlay');
  stack.push(id);
  return id;
}

/** Forgets an overlay, wherever it sits. Removing it twice is harmless. */
export function removeOverlay(id: symbol | null): void {
  if (id === null) return;
  const index = stack.lastIndexOf(id);
  if (index !== -1) stack.splice(index, 1);
}

/** Whether this overlay should answer Escape and trap Tab. */
export function isTopOverlay(id: symbol | null): boolean {
  return id !== null && stack.length > 0 && stack[stack.length - 1] === id;
}
