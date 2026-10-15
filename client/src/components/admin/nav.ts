import type { ComponentType } from 'react';
import { PERMISSIONS } from '@got/shared';
import { filterNavGroups, type NavGate } from '@/lib/rbac/nav';
import type { PermissionSet } from '@/lib/rbac/permissions';
import {
  IconCalendar,
  IconChart,
  IconChat,
  IconDashboard,
  IconGear,
  IconHistory,
  IconBell,
  IconMegaphone,
  IconQr,
  IconShield,
  IconUserPlus,
  IconWallet,
  IconScan,
} from '@/components/portal/icons';

export interface AdminNavItem extends NavGate {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /**
   * The permission a caller must hold for this screen to be useful — at ALL
   * unless the item says otherwise, because every console screen lists other
   * people and an OWN grant (a coach's `checkin.read`, say) opens none of them.
   *
   * The sidebar HIDES rather than disables an item the caller cannot use: a
   * front-desk operator does not need to know an admin-only screen exists, and
   * a nav full of dead links teaches staff to ignore the nav. The server is
   * still the authority — every one of these routes is permission-checked
   * server-side, and hiding a link has never been a security control.
   */
  permission: string;
  /** Built server-side but not yet on screen; shown, marked, and inert. */
  soon?: boolean;
}

export interface AdminNavGroup {
  heading: string;
  items: AdminNavItem[];
}

/**
 * Single source of truth for CRM navigation.
 *
 * The grouping follows the mockup's information architecture — Overview,
 * Members, Finance, System — because it matches how the work is actually
 * divided at the counter: who is here now, who owes us money, and what is
 * configured.
 */
export const ADMIN_NAV: AdminNavGroup[] = [
  {
    heading: 'Overview',
    items: [
      {
        href: '/admin',
        label: 'Dashboard',
        icon: IconDashboard,
        permission: PERMISSIONS.MEMBER_READ,
      },
      // Figure 22 of the proposal: expiration alerts beside system notices.
      // `notification.read` rather than `membership.read` — the stored column
      // is this screen's own, and the derived one degrades to a short note for
      // anybody who cannot read memberships.
      {
        href: '/admin/notifications',
        label: 'Notifications',
        icon: IconBell,
        permission: PERMISSIONS.NOTIFICATION_READ,
      },
    ],
  },
  {
    heading: 'Members',
    items: [
      {
        href: '/admin/members',
        label: 'Members',
        icon: IconUserPlus,
        permission: PERMISSIONS.MEMBER_READ,
      },
      // Enquiries from people who are not members yet. Under Members rather
      // than a section of its own: it is the same job, one step earlier.
      { href: '/admin/leads', label: 'Leads', icon: IconChat, permission: PERMISSIONS.MEMBER_READ },
      // Subscriptions is GONE, folded into Members above. It was a second
      // screen about the same people that structurally could not show anyone
      // without a plan, and the only thing it really owned was an order —
      // `endsOn` ascending, the renewal call sheet. That lives on as
      // `/admin/members?sort=ending`, one click away on the "Expiring soon"
      // chip. `/admin/subscriptions` still resolves: `next.config.ts` keeps a
      // redirect for the `SystemNotification.linkPath` rows already stored in
      // production pointing at it.
      //
      // Nothing is hidden by dropping the `membership.read` entry: every
      // seeded role that holds it also holds `member.read` (permission
      // registry's grant table — FRONT_DESK, COACH at OWN, ADMIN), and a
      // hand-granted `membership.read` without `member.read` would 403 on
      // `/members` anyway.
      {
        href: '/admin/attendance',
        label: 'Attendance',
        icon: IconHistory,
        permission: PERMISSIONS.CHECKIN_READ,
      },
      // walkin.sell, NOT checkin.read: a coach holds checkin.read at OWN, and
      // a coach has no business with the day-pass register. walkin.sell is
      // FRONT_DESK + ADMIN — exactly the two roles whose job this is.
      {
        href: '/admin/walk-ins',
        label: 'Walk-ins',
        icon: IconScan,
        permission: PERMISSIONS.WALKIN_SELL,
      },
    ],
  },
  {
    heading: 'Finance',
    items: [
      {
        href: '/admin/payments',
        label: 'Payments',
        icon: IconWallet,
        permission: PERMISSIONS.PAYMENT_READ,
      },
      // Revenue is no longer its own screen: it is the Revenue tab of Reports,
      // behind `revenue.read` (ADMIN only — owner decision, 2026-09-25).
      // `/admin/revenue` redirects there (next.config.ts).
      //
      // Figure 21 of the proposal: attendance, membership and walk-in
      // statistics with PDF/CSV export. payment.read because the walk-in
      // panel shows takings — and the front desk keeps it exactly as it was.
      {
        href: '/admin/reports',
        label: 'Reports',
        icon: IconHistory,
        permission: PERMISSIONS.PAYMENT_READ,
      },
    ],
  },
  {
    heading: 'System',
    items: [
      {
        href: '/admin/classes',
        label: 'Classes',
        icon: IconCalendar,
        permission: PERMISSIONS.CLASS_READ,
      },
      {
        href: '/admin/coaches',
        label: 'Coaches',
        icon: IconChart,
        permission: PERMISSIONS.COACH_READ,
      },
      {
        href: '/admin/stations',
        label: 'Stations',
        icon: IconQr,
        permission: PERMISSIONS.STATION_MANAGE,
      },
      // `announcement.create`, not `.read`: this is the screen that WRITES
      // notices. Everybody reads them on the dashboard and through the topbar
      // bell; the front desk, which cannot post, no longer gets a tab of
      // controls it cannot use (owner decision, 2026-09-25).
      {
        href: '/admin/announcements',
        label: 'Announcements',
        icon: IconMegaphone,
        permission: PERMISSIONS.ANNOUNCEMENT_CREATE,
      },
      // ── Staff & Access ──
      // Who works here, inviting more, and what each role can do.
      // `staff.invite` (ADMIN; DEV through its bypass). Which ROLES a caller
      // may invite or give is the role hierarchy's call, on the page and on
      // the server.
      {
        href: '/admin/staff',
        label: 'Staff & Access',
        icon: IconShield,
        permission: PERMISSIONS.STAFF_INVITE,
      },
      // ── end Staff & Access ──
      // `audit.read` has been a seeded permission with no table behind it since
      // the RBAC work shipped. It finally has one, and the proposal's own
      // Settings screen links here — so it sits next to Settings.
      {
        href: '/admin/audit',
        label: 'Audit Logs',
        icon: IconHistory,
        permission: PERMISSIONS.AUDIT_READ,
      },
      {
        href: '/admin/settings',
        label: 'Settings',
        icon: IconGear,
        permission: PERMISSIONS.PLAN_READ,
      },
    ],
  },
];

const ALL_ITEMS = ADMIN_NAV.flatMap((group) => group.items);

/**
 * The nav item that owns a path. Longest match first, so `/admin/members/abc`
 * resolves to Members rather than falling back to the Dashboard's bare
 * `/admin` prefix.
 *
 * The shell guards the page with this item's own permission, so a screen
 * hidden from the nav and the same screen opened by URL cannot disagree.
 */
export function adminNavItemForPath(pathname: string): AdminNavItem | undefined {
  return [...ALL_ITEMS]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));
}

export function adminTitleForPath(pathname: string): string {
  return adminNavItemForPath(pathname)?.label ?? 'Admin';
}

/**
 * Only the groups with at least one item this caller can use — scope-aware,
 * at ALL unless an item says otherwise. `null` (loading) shows nothing.
 */
export function visibleNav(permissions: PermissionSet): AdminNavGroup[] {
  return filterNavGroups(ADMIN_NAV, permissions, 'ALL');
}

/**
 * The four screens that earn a bottom tab on a phone, in counter order.
 *
 * Resolved against `ADMIN_NAV` rather than re-declared, so a label or icon
 * changes in exactly one place. Filtered through the SAME `visibleNav` result
 * as the sidebar, so the bar can never offer a screen the sidebar hides.
 *
 * Four, not five: the fifth column belongs to "More", which carries everything
 * else plus the surface switch and Sign out.
 */
const PRIMARY_HREFS = ['/admin', '/admin/members', '/admin/attendance', '/admin/payments'];

export function primaryTabs(groups: readonly AdminNavGroup[]): AdminNavItem[] {
  const available = new Map(groups.flatMap((group) => group.items).map((item) => [item.href, item]));
  return PRIMARY_HREFS.map((href) => available.get(href)).filter(
    (item): item is AdminNavItem => item !== undefined,
  );
}
