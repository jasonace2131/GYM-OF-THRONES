'use client';

import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePortalContainer } from '@/components/ui/portal-container';
import { cn } from '@/lib/utils';

const noSubscribe = (): (() => void) => () => undefined;

/**
 * A full-viewport screen ABOVE the portal chrome — the workout session and
 * the "Workout done" screen (PhoneSession.dc.html, PhoneFinish.dc.html) — with
 * no change to the portal layout.
 *
 * It mounts inside `.portal-root` (so every token and reset still applies),
 * as a SIBLING of the shell, which lets it make the shell, the tab bar and
 * everything else behind it `inert` while it is open: Tab cannot wander into
 * a sidebar nobody can see, and a screen reader reads only the workout. The
 * page behind does not scroll under a thumb either.
 *
 * On a desktop the same phone column sits centred (max 560 px); the caller
 * centres its own header, content and bottom bar so their backgrounds still
 * run edge to edge.
 */
export function FocusOverlay({
  labelledBy,
  className,
  children,
}: {
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const container = usePortalContainer();
  // False on the server and in the hydration pass, true after: a portal needs the DOM.
  const mounted = useSyncExternalStore(
    noSubscribe,
    () => true,
    () => false,
  );
  const host = useRef<HTMLDivElement>(null);

  // Inert everything beside the overlay while it is open.
  useEffect(() => {
    const self = host.current;
    const parent = self?.parentElement;
    if (!mounted || self === null || parent === null || parent === undefined) return;
    const made: Element[] = [];
    for (const sibling of Array.from(parent.children)) {
      if (sibling === self || sibling.hasAttribute('inert')) continue;
      sibling.setAttribute('inert', '');
      made.push(sibling);
    }
    return () => made.forEach((el) => el.removeAttribute('inert'));
  }, [mounted, container]);

  // No scrolling the page behind the screen.
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, []);

  if (!mounted) return null;

  const node = (
    <div
      ref={host}
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelledBy}
      className={cn(
        'fixed inset-0 z-[60] flex flex-col bg-background font-sans text-foreground',
        className,
      )}
    >
      {children}
    </div>
  );
  return container === null ? node : createPortal(node, container);
}
