'use client';

import { useCallback, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { isTopOverlay, pushOverlay, removeOverlay } from '@/lib/overlayStack';

/**
 * The CRM's dialog shell.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WRITTEN RATHER THAN EXTRACTED, and the distinction is worth recording.
 *
 * `admin/stations/page.tsx` and `portal/schedule/page.tsx` each hand-roll an
 * overlay, but neither is a modal in the sense that matters: they are a
 * backdrop plus a card, with no focus management, no Escape, and no ARIA. The
 * only reusable part was the backdrop. Everything below is the part they were
 * both missing, which is exactly why it belongs in one file instead of a third
 * copy.
 *
 * Every behaviour here exists because a staff member will hit it at a counter
 * with somebody waiting:
 *
 *  - Focus moves INTO the dialog on open and RETURNS to the button that opened
 *    it on close. Without the return, closing a modal drops keyboard focus to
 *    the top of the page and the next Tab starts from the sidebar.
 *  - Focus is TRAPPED while open. A Tab that escapes into the page behind an
 *    overlay is focus nobody can see.
 *  - Escape closes — but NOT while a submit is in flight. A slow network plus
 *    an impatient Escape would otherwise discard a payment that is already
 *    being written, and the operator would have no way to know whether it
 *    landed.
 *  - The body does not scroll behind the overlay.
 *  - Only the TOPMOST overlay answers the keyboard (`lib/overlayStack.ts`).
 *    A confirmation opens over a form, a sale or a drawer, and without this
 *    one Escape closed both of them.
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

export interface ModalProps {
  open: boolean;
  title: string;
  /** One line under the title. Omit rather than pad it with filler. */
  subtitle?: string;
  onClose: () => void;
  /** While true, Escape and the backdrop will not close the dialog. */
  busy?: boolean;
  children: ReactNode;
  /** Buttons. Rendered right-aligned in the footer; omit for a bare dialog. */
  footer?: ReactNode;
  /**
   * 760px instead of 440px — for content with two columns of its own, like
   * the walk-in checkout. A confirmation never needs it; a transaction does.
   */
  wide?: boolean;
  /**
   * Where focus lands on open. Omitted, it is the first focusable control.
   * `ConfirmDialog` points it at its cancel button: the safe choice is the
   * one an accidental Enter should hit.
   */
  initialFocus?: RefObject<HTMLElement | null>;
  /** An element id inside the body that describes the dialog, when there is no subtitle. */
  describedBy?: string;
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  busy = false,
  children,
  footer,
  wide = false,
  initialFocus,
  describedBy,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const overlayRef = useRef<symbol | null>(null);
  // Read through a ref so the open effect below keeps its `[open]` deps: a
  // caller passing a fresh ref object each render must not re-run it.
  const initialFocusRef = useRef(initialFocus);
  useEffect(() => {
    initialFocusRef.current = initialFocus;
  });
  const titleId = useId();
  const subtitleId = useId();

  const requestClose = useCallback(() => {
    if (busy) return;
    onClose();
  }, [busy, onClose]);

  // Remember the invoker BEFORE focus moves, and restore on unmount.
  useEffect(() => {
    if (!open) return;

    restoreRef.current = document.activeElement as HTMLElement | null;
    overlayRef.current = pushOverlay();
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = 'hidden';

    // Deferred one frame: the panel's children mount with it, so querying for
    // a field synchronously here finds an empty node on the first render.
    const focusFirst = window.setTimeout(() => {
      const panel = panelRef.current;
      if (panel === null) return;
      const preferred = initialFocusRef.current?.current ?? null;
      const target = preferred ?? panel.querySelector<HTMLElement>(FOCUSABLE);
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
      // A dialog opened over this one owns the keyboard until it closes.
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

      // Wrap in both directions. Without this the trap leaks on Shift+Tab from
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
    <div className="a-modal-backdrop" onMouseDown={requestClose}>
      <div
        ref={panelRef}
        className={wide ? 'a-modal a-modal--wide' : 'a-modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle === undefined ? describedBy : subtitleId}
        tabIndex={-1}
        // The backdrop closes on click; the panel must not inherit that.
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="a-modal-head">
          <div>
            <h2 className="a-modal-title" id={titleId}>
              {title}
            </h2>
            {subtitle !== undefined && (
              <p className="a-modal-sub" id={subtitleId}>
                {subtitle}
              </p>
            )}
          </div>
          <button
            type="button"
            className="a-modal-x"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </header>

        <div className="a-modal-body">{children}</div>

        {footer !== undefined && <footer className="a-modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

/** The error strip every action modal shows above its footer. */
export function ModalError({ message }: { message: string | null }) {
  if (message === null) return null;
  return (
    <div className="a-modal-err" role="alert">
      {message}
    </div>
  );
}
