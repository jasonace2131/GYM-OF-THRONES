import type { Viewport } from 'next';
import PortalClientLayout from './PortalClientLayout';

/**
 * A server layout only so the portal can export `viewport` — the shell itself
 * is a client component (`PortalClientLayout.tsx`), and a client module
 * cannot export it.
 *
 * `viewportFit: 'cover'` lets the member portal draw under the notch and the
 * home indicator, which is what makes the `env(safe-area-inset-*)` values in
 * portal.css (tab bar, sticky bars, side gutters) and the bottom sheets
 * non-zero on an iPhone. It lives HERE, not in the root layout: the landing
 * page, auth, the Admin CRM and the desk do not pad for the safe areas, so
 * `cover` there would put their content under the notch. Next merges
 * `viewport` key by key from the root down, so the root's themeColor and
 * colorScheme still apply.
 */
export const viewport: Viewport = {
  viewportFit: 'cover',
};

export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return <PortalClientLayout>{children}</PortalClientLayout>;
}
