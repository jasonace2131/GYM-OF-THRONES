'use client';

import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { isTopOverlay, pushOverlay, removeOverlay } from '@/lib/overlayStack';

/**
 * The CRM's side panel — same a11y contract as `Modal.tsx`, different shape.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * COPIED FROM `Modal.tsx` WHOLESALE, deliberately.
 *
 * A drawer that traps focus more loosely than the dialog it sits beside is a
 * drawer a keyboard user can tab out of into a table that is still open
 * behind it. Every hazard `Modal.tsx` guards against — focus lost on close,
 * a Tab escaping the panel, Escape discarding in-flight work, the body
 * scrolling behind the overlay — applies here exactly as written there, so
 * the fix is copied rather than reinvented.
 *
 * The one real difference: `Modal` owns its header (title/subtitle/close
 * button) because every modal's content is a bare form. A member drawer's
 * header is `<Person>` + `<StandingBadge>` + a role chip + a ⋯ menu — content
 * only the caller can compose — so `Drawer` renders `children` only and takes
 * an explicit `label` for `aria-label` instead of an internal `<h2>` id.
 * ─────────────────────────────────────────────────────────────────────────
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface DrawerProps {
  open: boolean;
  /** The dialog's accessible name — read once, on open, by a screen reader. */
  label: string;
  onClose: () => void;
  /** While true, Escape and the backdrop will not close the drawer. */
  busy?: boolean;
  children: ReactNode;
}

export function Drawer({ open, label, onClose, busy = false, children }: DrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<symbol | null>(null);

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // Remember the invoker BEFORE focus moves, and restore on unmount — the row
  // that opened the drawer gets focus back, not the top of the page.
  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    // Registered on open so a dialog opened over the drawer — Edit, Void, a
    // confirmation — owns Escape and Tab until it closes (`lib/overlayStack`).
    overlayRef.current = pushOverlay();
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    // Deferred one frame: the panel's children mount with it, so querying for
    // a field synchronously here finds an empty node on the first render.
    const focusFirst = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel === null) return;
      const target = panel.querySelector<HTMLElement>(FOCUSABLE);
      (target ?? panel).focus();
    }, 0);

    return () => {
      window.clearTimeout(focusFirst);
      removeOverlay(overlayRef.current);
      overlayRef.current = null;
      body.style.overflow = previousOverflow;
      restoreRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isTopOverlay(overlayRef.current)) return;

      if (event.key === 'Escape') {
        event.stopPropagation();
        requestClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;

      const focusable = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      );
      if (focusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      // Wrap in both directions — the trap must not leak on Shift+Tab from
      // the first field, which is the direction people actually discover.
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open, requestClose]);

  if (!open) return null;

  return (
    <div className="a-modal-backdrop a-drawer-backdrop" onMouseDown={requestClose}>
      <div
        ref={panelRef}
        className="a-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        // The backdrop closes on click; the panel must not inherit that.
        onMouseDown={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}
