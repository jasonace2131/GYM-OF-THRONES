'use client';

import { useCallback, useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { PERMISSIONS } from '@got/shared';
import { supabase } from '@/lib/supabase';
import { ShiftPill } from '@/components/admin/ShiftPill';
import { MeProvider, useMe } from '@/components/rbac/MeProvider';
import {
  adminNavItemForPath,
  adminTitleForPath,
  primaryTabs,
  visibleNav,
} from '@/components/admin/nav';
import { RequirePermission } from '@/components/rbac/guards';
import { hasPermission } from '@/lib/rbac/permissions';
import { STAFF_HOME, isStaff } from '@/lib/safeNext';
import { IconSignOut } from '@/components/portal/icons';
import { SurfaceSwitch } from '@/components/portal/SurfaceSwitch';
import { MobileTabBar } from '@/components/portal/Sidebar';
import { MoreSheet } from '@/components/portal/MoreSheet';
import { PortalContainerProvider } from '@/components/ui/portal-container';
import { AnnouncementsProvider } from '@/components/announcements/AnnouncementsProvider';
import { NotificationBell } from '@/components/announcements/NotificationBell';
import '../portal.css';
import '../admin.css';
// The CRM's reports range picker needs a real calendar with keyboard
// navigation, so the console now loads Tailwind too. It is still contained:
// `tailwind.css` scans only the folders its @source lines name, and the only
// admin folder named is `components/admin/range`. Every existing admin rule in
// `admin.css` is UNLAYERED and therefore still beats `@layer base` here.
import '../tailwind.css';

/**
 * The staff CRM shell.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE NAV IS BUILT FROM THE CALLER'S OWN PERMISSIONS, NOT THEIR ROLE.
 *
 * `GET /me` returns the effective permission set, and the sidebar renders the
 * screens that set can use. A role test here would hard-code today's grant
 * table into the client and silently stop agreeing with it the first time a
 * grant is edited — a front-desk operator given `payment.read` would still see
 * no Payments link, and nobody would know why.
 *
 * Hiding a link is NOT a security control and is not treated as one. Every
 * route behind these links is permission-checked server-side; hiding is purely
 * so staff are not shown doors they cannot open.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * It reuses `portal.css` wholesale — the shell carries both `portal-root` and
 * `admin-root` — because the member portal and the CRM are two halves of one
 * product, and a second design system is two places to change a colour and one
 * place to forget.
 *
 * `/me` now lives in `MeProvider` (`components/rbac/MeProvider.tsx`), shared
 * with every page inside the shell and kept fresh on focus and after a 403,
 * so a revoked grant takes its nav item and its controls with it without a
 * reload. The gate below reads that provider rather than fetching on its own.
 */

/**
 * `unreachable` exists because its absence was a bug.
 *
 * Every `/me` failure used to become `anonymous`, and `anonymous` redirects to
 * `/login`. So a dev-server restart, a dropped frame or a 429 logged a valid
 * staff session out and bounced them to a login page that signed them straight
 * back in — a loop in which every request in the network tab is a 200. Only a
 * 401 actually means "not signed in"; everything else is a network or server
 * problem, and the console must say so and offer a retry instead of throwing
 * the session away.
 *
 * `portal/layout.tsx` already reasons this way and says so in its own comment:
 * "a failed profile read is a network blip, not an authorisation problem."
 * These two shells must agree.
 */
type Gate = 'checking' | 'ok' | 'anonymous' | 'forbidden' | 'unreachable';

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <MeProvider surface="admin">
      <AdminShell>{children}</AdminShell>
    </MeProvider>
  );
}

function AdminShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { status, me, errorStatus, reload } = useMe();
  const [moreOpen, setMoreOpen] = useState(false);

  // 401 is the ONLY failure that means "not signed in". 403 is a real answer
  // from a working server. Anything else — offline, 5xx, 429, a dev server
  // mid-restart — is a failure to ASK, and destroying a valid session over it
  // is how the login loop happened.
  //
  // The CRM's floor is `member.read` AT A SCOPE THAT REACHES OTHER PEOPLE. A
  // COACH holds `member.read` at scope OWN, and a scope-blind test once
  // painted the whole console for them. `isStaff` is the only answer, shared
  // with the login redirect.
  const gate: Gate =
    me !== null
      ? isStaff(me.permissions)
        ? 'ok'
        : 'forbidden'
      : status === 'loading'
        ? 'checking'
        : errorStatus === 401
          ? 'anonymous'
          : errorStatus === 403
            ? 'forbidden'
            : 'unreachable';

  useEffect(() => {
    if (gate !== 'anonymous') return;
    const search = typeof window === 'undefined' ? '' : window.location.search;
    router.replace(`/login?next=${encodeURIComponent(`${pathname}${search}`)}`);
  }, [gate, pathname, router]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    router.replace('/login');
  }, [router]);

  if (gate !== 'ok' || me === null) {
    return (
      <div className="portal-root admin-root">
        <div style={{ display: 'grid', placeItems: 'center', minHeight: '100vh', padding: 24 }}>
          <div style={{ textAlign: 'center', maxWidth: 380 }}>
            <div
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 11,
                letterSpacing: '0.2em',
                textTransform: 'uppercase',
                color: 'var(--p-ink3)',
              }}
            >
              {gate === 'checking'
                ? 'Loading the console…'
                : gate === 'forbidden'
                  ? 'Staff only'
                  : gate === 'unreachable'
                    ? 'Could not reach the server'
                    : 'Redirecting…'}
            </div>
            {gate === 'forbidden' ? (
              <p style={{ marginTop: 12, color: 'var(--p-ink2)', fontSize: 14, lineHeight: 1.5 }}>
                This account does not have console access. If you are a member, your portal is at{' '}
                <Link href="/portal/dashboard" style={{ color: 'var(--gold-dark)' }}>
                  /portal
                </Link>
                .
              </p>
            ) : null}
            {gate === 'unreachable' ? (
              <>
                <p style={{ marginTop: 12, color: 'var(--p-ink2)', fontSize: 14, lineHeight: 1.5 }}>
                  You are still signed in — the console just could not load your profile. This is
                  usually the network or the API restarting.
                </p>
                <button
                  type="button"
                  className="p-btn p-btn-gold p-btn-sm"
                  style={{ marginTop: 14 }}
                  onClick={reload}
                >
                  Try again
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const groups = visibleNav(me.permissions);
  const current = adminNavItemForPath(pathname);
  const initials = `${me.firstName[0] ?? ''}${me.lastName[0] ?? ''}`.toUpperCase();
  // The desk sees announcements through the bell and the dashboard's
  // noticeboard rather than the Announcements tab (owner decision,
  // 2026-09-25) — so both mount for anyone who may read them.
  const canReadNotices = hasPermission(me.permissions, PERMISSIONS.ANNOUNCEMENT_READ);

  return (
    <AdminFrame notices={canReadNotices}>
      <div className="p-shell">
        <aside className="p-sidebar">
          <Link href="/admin" className="p-brand">
            <Image
              src="/assets/logo.webp"
              alt=""
              aria-hidden
              width={34}
              height={34}
              style={{
                borderRadius: '50%',
                objectFit: 'cover',
                border: '1.5px solid rgba(201,146,42,.5)',
                flex: 'none',
              }}
            />
            <span>
              <span className="p-brand-name">GYM OF THRONES</span>
              <span className="p-brand-sub">Admin CRM</span>
            </span>
          </Link>

          <nav className="p-nav">
            {groups.map((group) => (
              <div key={group.heading}>
                <div className="p-nav-group">{group.heading}</div>
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active =
                    pathname === item.href ||
                    (item.href !== '/admin' && pathname.startsWith(`${item.href}/`));

                  if (item.soon === true) {
                    return (
                      <span
                        key={item.href}
                        className="p-link"
                        style={{ opacity: 0.38, cursor: 'default' }}
                        title="Coming soon"
                      >
                        <Icon />
                        {item.label}
                      </span>
                    );
                  }

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className="p-link"
                      data-active={active}
                      aria-current={active ? 'page' : undefined}
                    >
                      <Icon />
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            ))}

            <div className="p-nav-spacer" />

            {/* "My member portal" used to sit here. It is now <SurfaceSwitch>
                in the topbar, matching the portal's, so the crossing looks and
                behaves identically from both sides instead of being a nav row
                on one and a nav row on the other with different wording. */}

            <button type="button" className="p-link" onClick={() => void signOut()}>
              <IconSignOut />
              Sign out
            </button>
          </nav>
        </aside>

        <div className="p-main">
          <header className="p-topbar">
            <span className="p-page-title">{adminTitleForPath(pathname)}</span>

            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
              <ShiftPill canManage={hasPermission(me.permissions, PERMISSIONS.SHIFT_MANAGE)} />
              {canReadNotices ? <NotificationBell /> : null}
              <span
                className="hide-mobile"
                style={{ fontSize: 13, fontWeight: 500, color: 'var(--p-ink2)' }}
              >
                {me.firstName} {me.lastName}
              </span>
              {/* Role is the first thing to go when the bar gets tight: it is
                  the least actionable item here, and dropping it is what makes
                  room for the switch at 360px. */}
              <span className="p-badge p-badge-neutral hide-mobile">
                {me.role.replace('_', ' ')}
              </span>
              <SurfaceSwitch to="portal" />
              <span className="p-avatar">{initials}</span>
            </div>
          </header>

          <main className="p-content">
            {/* A screen the nav hides, opened by URL, gets one clean "not for
                your role" card instead of its chrome and a column of 403
                cards — guarded by its nav item's own permission, so the two
                cannot disagree. */}
            {current === undefined ? (
              children
            ) : (
              <RequirePermission permission={current.permission} scope={current.scope ?? 'ALL'}>
                {children}
              </RequirePermission>
            )}
          </main>
        </div>
      </div>

      {/* Below 900px `.p-sidebar` is hidden and, until now, nothing replaced
          it — the console had NO navigation on a phone or on the counter
          tablet in portrait. `.p-content` was already reserving 96px for this
          bar. Same components as the portal, so the two shells cannot drift. */}
      <MobileTabBar
        items={primaryTabs(groups)}
        onMore={() => setMoreOpen(true)}
        label="Console sections"
      />
      <MoreSheet
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        groups={groups.map((group) => ({ label: group.heading, items: group.items }))}
        onSignOut={() => void signOut()}
        switchTo={<SurfaceSwitch to="portal" />}
      />
    </AdminFrame>
  );
}

/**
 * The console's root element and the two things that hang off it.
 *
 * - A portal container: Radix portals (the bell's popover, the reports range
 *   picker) mount INSIDE `.portal-root`, so the tokens and resets scoped there
 *   still apply — the fix `portal/layout.tsx` already makes; see
 *   components/ui/portal-container.tsx.
 * - The announcements feed, for callers who may read notices. It is pointed at
 *   the CONSOLE dashboard, so the bell's rows and "View all" land on
 *   `/admin?notice=…` and never hand staff across to the member portal.
 */
function AdminFrame({ notices, children }: { notices: boolean; children: React.ReactNode }) {
  // A callback ref into state, so the provider re-renders once the element exists.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div className="portal-root admin-root" ref={setRoot}>
      <PortalContainerProvider container={root}>
        {notices ? (
          <AnnouncementsProvider noticesHome={STAFF_HOME}>{children}</AnnouncementsProvider>
        ) : (
          children
        )}
      </PortalContainerProvider>
    </div>
  );
}
