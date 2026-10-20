'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { MEMBER_DEVICE_CACHE_KEYS, clearMemberDeviceCache } from '@/lib/deviceCache';
import { apiFetch } from '@/lib/api';
import { COACH_HOME, isCoach, isStaff } from '@/lib/safeNext';
import { PORTAL_NOTICES_HOME } from '@/lib/announcements/focus';
import { MeProvider, useMe } from '@/components/rbac/MeProvider';
import { MobileTabBar, Sidebar } from '@/components/portal/Sidebar';
import { titleForPath, visibleNav, visibleTabs } from '@/components/portal/nav';
import { SurfaceSwitch } from '@/components/portal/SurfaceSwitch';
import { MoreSheet } from '@/components/portal/MoreSheet';
import { Toaster } from '@/components/ui/sonner';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import { AnnouncementsProvider } from '@/components/announcements/AnnouncementsProvider';
import { MemberNoticesProvider } from '@/components/announcements/MemberNoticesProvider';
import { NotificationBell } from '@/components/announcements/NotificationBell';
import { ConsentGate } from '@/components/portal/ConsentGate';
import { RealtimeProvider } from '@/components/chat/RealtimeProvider';
import type { LegalDocumentKind } from '@got/shared';
import '../portal.css';
import '../tailwind.css';

/**
 * The member's check-in screen. Two rules apply to it and to nothing else,
 * written down because both look like bugs to anyone who does not know why.
 */
const CHECKIN_PATH = '/portal/checkin';

type AuthState = 'checking' | 'authed' | 'anonymous';

/**
 * `/me` for the whole portal lives in `MeProvider`, shared with every page so
 * a page can guard itself (`<RequirePermission>`) and gate its own controls
 * (`usePermission`, `<Can>`), and kept fresh on focus and after a 403.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  return (
    <MeProvider surface="portal">
      {/* feat/coach-tools: the coach chat's ONE Realtime socket and its state.
          It reads `/me`, connects only for a caller holding chat.use, and
          feeds the nav's unread badges. */}
      <RealtimeProvider>
        <PortalShell>{children}</PortalShell>
      </RealtimeProvider>
    </MeProvider>
  );
}

function PortalShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [auth, setAuth] = useState<AuthState>('checking');
  const [initials, setInitials] = useState('—');
  const [name, setName] = useState('');
  const { me } = useMe();
  /**
   * The caller's own permission set, from the shared `/me`.
   *
   * `null` until it lands, and reset only on sign-out: a failed REFRESH keeps
   * the last known answer (see `meReducer`), so an hourly TOKEN_REFRESHED that
   * happens to fail does not make a coach's dashboard or a staff member's
   * console switch vanish, and a second account signing in on the same phone
   * inherits nothing from the first.
   */
  const permissions = me?.permissions ?? null;
  /** Three states, not a boolean: unknown until `/me` answers. */
  const staff: 'unknown' | 'yes' | 'no' =
    permissions === null ? 'unknown' : isStaff(permissions) ? 'yes' : 'no';
  const [moreOpen, setMoreOpen] = useState(false);
  /** The topbar's name and avatar link to My account when its nav row is visible. */
  const showAccount = visibleNav(permissions).some((group) =>
    group.items.some((item) => item.href === '/portal/account'),
  );
  /**
   * `null` while unknown — NOT an empty array, which would be
   * indistinguishable from "nothing outstanding" and would flash the portal
   * to a member who is about to be blocked.
   */
  const [outstanding, setOutstanding] = useState<LegalDocumentKind[] | null>(null);
  /**
   * The `.portal-root` element, so Radix portals (sheets, dialogs, selects,
   * the bell's popover) mount INSIDE it and keep the tokens and resets scoped
   * there — see components/ui/portal-container.tsx. A callback ref into state,
   * declared with the other hooks above every early return.
   */
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    const apply = (
      session: Awaited<ReturnType<typeof supabase.auth.getSession>>['data']['session'],
    ) => {
      if (cancelled) return;

      if (!session) {
        // Covers session expiry and a sign-out in another tab, not only the
        // explicit signOut() below — otherwise the previous member's card
        // (name, code, photo) stays in localStorage on a shared phone.
        clearMemberDeviceCache();
        setAuth('anonymous');
        // Staff-ness and sections are forgotten by `MeProvider` on sign-out.
        // The next account to sign in on this device must not inherit the
        // previous one's consent standing either.
        setOutstanding(null);
        return;
      }

      const meta = (session.user.user_metadata ?? {}) as Record<string, unknown>;
      const first = typeof meta['firstName'] === 'string' ? meta['firstName'] : '';
      const last = typeof meta['lastName'] === 'string' ? meta['lastName'] : '';
      const fallback = session.user.email?.[0] ?? '?';

      setName([first, last].filter(Boolean).join(' ') || (session.user.email ?? ''));
      setInitials(((first[0] ?? fallback) + (last[0] ?? '')).toUpperCase());
      setAuth('authed');

      // `/me` itself is `MeProvider`'s. This is a separate call, deliberately:
      // a failure here must not cost the member their staff link, and a
      // failure there must not lock them out of the portal. On failure we
      // FALL OPEN — an unreachable API is not evidence
      // that somebody has not consented, and blocking the gym on a network
      // blip is worse than a late prompt they will get on the next load.
      void apiFetch<{ outstanding: LegalDocumentKind[] }>('/me/consent')
        .then((standing) => {
          if (!cancelled) setOutstanding(standing.outstanding);
        })
        .catch(() => {
          if (!cancelled) setOutstanding([]);
        });
    };

    void supabase.auth.getSession().then(({ data }) => apply(data.session));

    // Keeps the shell honest if the session expires or the user signs out in
    // another tab, rather than leaving a stale portal on screen.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => apply(session));

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (auth !== 'anonymous') return;

    // EXCEPTION 1 — do not bounce /portal/checkin to login while offline.
    // getSession() is a local read and works offline, but a redirect here
    // sends a member standing at the desk to a page that needs the network
    // they do not have. With a cached identity we render in place instead, so
    // the screen's offline job — getting them served by a human — still works.
    // There is no offline check-in queue at any TTL (§6.10.2): check-in
    // genuinely requires a round trip.
    if (
      pathname === CHECKIN_PATH &&
      typeof navigator !== 'undefined' &&
      !navigator.onLine &&
      MEMBER_DEVICE_CACHE_KEYS.some((key) => window.localStorage.getItem(key) !== null)
    ) {
      return;
    }

    // `window.location.search` rather than useSearchParams(): this is a client
    // layout wrapping every portal page, and useSearchParams() here would force
    // each of them dynamic and demand a Suspense boundary at build time. Inside
    // an effect the read is client-only and safe.
    const search = typeof window === 'undefined' ? '' : window.location.search;
    const next = `${pathname}${search}`;
    router.replace(`/login?next=${encodeURIComponent(next)}`);
  }, [auth, pathname, router]);

  const signOut = useCallback(async () => {
    // Cleared FIRST, so a failing signOut still leaves no member identity on
    // the device. A shared or resold phone must not render the previous
    // member's name, code and photo on a card designed to be handed to staff.
    clearMemberDeviceCache();
    await supabase.auth.signOut();
    router.replace('/login');
  }, [router]);

  // NON-CHANGE, deliberate (owner decision 3): there is no idle timeout on
  // member phones. Do not add one "for consistency" — the desk console's PIN
  // is an operator switch, which is a different control on a different device.

  // Render a neutral surface while the session resolves rather than flashing
  // the portal to someone who is about to be redirected out of it.
  if (auth !== 'authed') {
    return (
      <div className="portal-root">
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 11,
              letterSpacing: '0.2em',
              textTransform: 'uppercase',
              color: 'var(--p-ink3)',
            }}
          >
            {auth === 'checking' ? 'Loading…' : 'Redirecting…'}
          </div>
        </div>
      </div>
    );
  }

  /*
   * The gate sits AFTER the auth check and BEFORE the shell, so a member who
   * owes a document never sees the portal behind it — including for the one
   * frame a modal overlay would allow.
   */
  if (outstanding !== null && outstanding.length > 0) {
    return (
      <ConsentGate
        outstanding={outstanding}
        onAccepted={() => setOutstanding([])}
        onSignOut={() => void signOut()}
      />
    );
  }

  return (
    <div className="portal-root" ref={setPortalRoot}>
      <PortalContainerProvider container={portalRoot}>
        {/* One feed for the shell: the bell and the dashboard's notices share
            it, so neither fetches what the other already has. A coach reads
            notices on the coach dashboard they land on, so their bell's links
            point there. */}
        <AnnouncementsProvider
          noticesHome={isCoach(permissions) ? COACH_HOME : PORTAL_NOTICES_HOME}
        >
          {/* The member's own notices — a seat that opened up, a class called
              off or moved, a booking the desk made or removed — which the bell
              lists beside the announcements. The portal only: the console's
              bell carries announcements alone and works without this. */}
          <MemberNoticesProvider>
            <div className="p-shell">
              <Sidebar onSignOut={signOut} permissions={permissions} />

              <div className="p-main">
                <header className="p-topbar">
                  <span className="p-page-title">{titleForPath(pathname)}</span>

                  <div
                    style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 14 }}
                  >
                    {/*
                    [Staff console →] [Bell] [Name · avatar].

                    THE BELL IS BACK, AND NOW IT IS REAL. The one that used to
                    live here had no onClick and a hardcoded "unread" dot lit
                    for every member on every page — a badge backed by no data,
                    which the CRM rule in CLAUDE.md ("shows nothing it cannot
                    source") forbids on the portal too. This one counts
                    announcements newer than the member's own watermark
                    (GET /me/announcements) plus the member's own unread
                    notices (GET /me/notices), and lists the newest of both;
                    announcements are read on the dashboard, a notice goes to
                    the day it is about.

                    It keeps the switch's 34px geometry, so the topbar does not
                    grow for either audience.
                  */}
                    {staff === 'yes' ? <SurfaceSwitch to="admin" /> : null}

                    <NotificationBell />

                    {/* The name and initials open My account for whoever has
                        that section (a member); for everybody else they stay
                        a plain label, so nobody is shown a door they lack. */}
                    {showAccount ? (
                      <Link
                        href="/portal/account"
                        aria-label="My account"
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          textDecoration: 'none',
                        }}
                      >
                        <span
                          className="hide-mobile"
                          style={{ fontSize: 13, fontWeight: 500, color: 'var(--p-ink2)' }}
                        >
                          {name}
                        </span>
                        <span className="p-avatar">{initials}</span>
                      </Link>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <span
                          className="hide-mobile"
                          style={{ fontSize: 13, fontWeight: 500, color: 'var(--p-ink2)' }}
                        >
                          {name}
                        </span>
                        <span className="p-avatar">{initials}</span>
                      </div>
                    )}
                  </div>
                </header>

                <main className="p-content">{children}</main>
              </div>
            </div>

            {/* `onMore` gives members Sign out on a phone for the first time —
            the sidebar that carries it is hidden below 900px. */}
            <MobileTabBar items={visibleTabs(permissions)} onMore={() => setMoreOpen(true)} />
            <MoreSheet
              open={moreOpen}
              onClose={() => setMoreOpen(false)}
              groups={visibleNav(permissions).map((group) => ({
                label: group.heading,
                items: group.items,
              }))}
              onSignOut={() => void signOut()}
              switchTo={staff === 'yes' ? <SurfaceSwitch to="admin" /> : undefined}
            />

            {/* Booking and cancellation feedback. Top-centre so it clears the
            mobile tab bar and the sticky top bar alike. */}
            <Toaster position="top-center" />
          </MemberNoticesProvider>
        </AnnouncementsProvider>
      </PortalContainerProvider>
    </div>
  );
}
