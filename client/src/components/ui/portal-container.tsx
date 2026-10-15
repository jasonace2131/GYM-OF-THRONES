'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Where Radix portals mount — the fix for overlays that lost the design system.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BUG THIS EXISTS FOR (confirmed in a browser, 2026-09-24).
 *
 * Every shadcn variable (`--background`, `--popover`, `--border`, …) is
 * defined under `.portal-root`, not `:root` (tailwind.css), and so are the
 * button/font resets that stand in for Preflight. Radix portals render into
 * `<body>`, OUTSIDE `.portal-root` — so the booking sheet, the cancel dialog
 * and the coach filter's dropdown all painted `rgba(0,0,0,0)` with the dark
 * landing page's near-white text, UA Arial buttons and square corners.
 *
 * Widening the variables to `:root` would not fix it: the resets are scoped
 * too, and unscoping them would restyle the landing page. Mounting the portal
 * INSIDE `.portal-root` fixes all of it at once.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The default is `null`, which every portal reads as "use `<body>`" — so a
 * surface that does not provide a container behaves exactly as before. Both
 * the member portal and the admin console (for its announcements bell and
 * range picker) now provide one. Deliberately no classes and no DOM of its own.
 */
const PortalContainerContext = createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
  container,
  children,
}: {
  container: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={container}>{children}</PortalContainerContext.Provider>
  );
}

/** The element portals should mount into, or `null` for `<body>`. */
export function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}
