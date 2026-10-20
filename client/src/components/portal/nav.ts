import type { ComponentType } from 'react';
import { PERMISSIONS } from '@got/shared';
import { filterNavGroups, filterNavItems, type NavGate } from '@/lib/rbac/nav';
import { activeHref } from '@/lib/navActive';
import type { PermissionSet } from '@/lib/rbac/permissions';
import {
  IconCalendar,
  IconCard,
  IconChart,
  IconChat,
  IconDashboard,
  IconDumbbell,
  IconGear,
  IconHistory,
  IconQr,
  IconUserPlus,
  IconWallet,
} from './icons';

export interface NavItem extends NavGate {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number }>;
  /**
   * A permission key the caller must hold for this item to appear, and
   * optionally the `scope` it must reach (default: any grant).
   *
   * Absent on the sections every signed-in person has. Two kinds of section
   * carry one: a JOB (Coaching, `coach.read`) and — since the owner's
   * 2026-09-25 decision that coaches, the desk and admins are not members
   * here — the member's OWN sections (`membership.self`, `progress.self`,
   * `coach.self`), which only CLIENT holds. The routes behind those stay
   * keyless, hard-coded to `request.user`; the key says who the section is
   * for.
   *
   * The same rule the console's sidebar follows: hiding a link is not a
   * security control, and every route behind one is permission-checked
   * server-side. This is so nobody is shown a door they cannot open.
   */
  permission?: string;
  /**
   * Which unread count this item shows, if any (feat/coach-tools). The shell
   * owns the numbers — `RealtimeProvider`'s chat state — and passes them in.
   */
  badge?: NavBadge;
  /** Other path roots this row lights for — see `activeHref` (lib/navActive). */
  activeFor?: readonly string[];
}

/** The chat's two unread counts: threads where I am the coach, and where I am the member. */
export type NavBadge = 'chatAsCoach' | 'chatAsMember';

export type NavBadgeCounts = Partial<Record<NavBadge, number>>;

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

/**
 * Single source of truth for portal navigation — the sidebar and the mobile
 * tab bar both read from here, so a route can never appear in one and not
 * the other.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Main',
    items: [
      { href: '/portal/dashboard', label: 'Dashboard', icon: IconDashboard },
      // The member's own AI workout planner (feat/member-workouts). Right
      // after Dashboard because it is the second thing a training member
      // opens; gated on `workout.member`, which only CLIENT holds, so a
      // coach or the desk is not offered a planner that 403s.
      {
        href: '/portal/workouts',
        label: 'Workouts',
        icon: IconDumbbell,
        permission: PERMISSIONS.WORKOUT_MEMBER,
      },
      { href: '/portal/schedule', label: 'Class Schedule', icon: IconCalendar },
      // A member's own bookings and visits. Gated on the keys only CLIENT
      // holds, so a coach — who books nothing and is not a member here
      // (owner, 2026-10-06: "the coach to be a coach only") — is not offered
      // them. Their routes stay keyless and hard-coded to the caller.
      {
        href: '/portal/book',
        label: 'My Bookings',
        icon: IconUserPlus,
        permission: PERMISSIONS.BOOKING_CREATE,
      },
      {
        href: '/portal/checkins',
        label: 'Check-in History',
        icon: IconHistory,
        permission: PERMISSIONS.MEMBERSHIP_SELF,
      },
    ],
  },
  {
    heading: 'Membership',
    items: [
      {
        href: '/portal/subscription',
        label: 'My Subscription',
        icon: IconCard,
        permission: PERMISSIONS.MEMBERSHIP_SELF,
      },
      {
        href: '/portal/pay',
        label: 'Pay / GCash',
        icon: IconWallet,
        permission: PERMISSIONS.MEMBERSHIP_SELF,
      },
    ],
  },
  {
    /**
     * The coach's own section — Figure 12 of the proposal, REQ020.
     *
     * It lives in the PORTAL and not the console because a coach is not staff
     * as this system defines staff: they hold `member.read` at scope OWN, so
     * `isStaff()` is false for them and `/admin` would bounce them. The portal
     * is where a coach actually lands, so their dashboard is a section of it.
     *
     * Its own group rather than a row under More: for the person who has it,
     * it is the reason they opened the app.
     */
    heading: 'Coaching',
    items: [
      // No "Coach Dashboard" row any more (owner, 2026-10-06): a coach had two
      // dashboards. Their Dashboard row above IS the coach view —
      // /portal/dashboard renders it for a coach — and /portal/coaching
      // redirects there for old links.
      //
      // "My Coach" is a member's; for a coach it becomes "My Clients" — the
      // hub (feat/coach-tools): every assigned client, each opening onto
      // Progress · Workout plan · Chat. A client's own page lives under
      // /portal/coaching/members, and stays lit as My Clients.
      {
        href: '/portal/coaching/clients',
        label: 'My Clients',
        icon: IconUserPlus,
        permission: PERMISSIONS.COACH_READ,
        activeFor: ['/portal/coaching/members'],
      },
      // The coach's inbox: coaching AND chat, so an admin (coach.read, no
      // chat.use) is not offered it. Carries the unread badge.
      {
        href: '/portal/coaching/messages',
        label: 'Messages',
        icon: IconChat,
        permission: PERMISSIONS.COACH_READ,
        requiresAlso: [PERMISSIONS.CHAT_USE],
        badge: 'chatAsCoach',
      },
    ],
  },
  {
    heading: 'More',
    items: [
      // Scanning in at the counter is a member's (coaches are not members
      // here, owner 2026-10-06), so it carries the member's key.
      {
        href: '/portal/checkin',
        label: 'Check In',
        icon: IconQr,
        permission: PERMISSIONS.MEMBERSHIP_SELF,
      },
      {
        href: '/portal/progress',
        label: 'My Progress',
        icon: IconChart,
        permission: PERMISSIONS.PROGRESS_SELF,
      },
      {
        href: '/portal/coach',
        label: 'My Coach',
        icon: IconChat,
        permission: PERMISSIONS.COACH_SELF,
        // The member's chat with their coach lives on this page.
        badge: 'chatAsMember',
      },
      // No Announcements item: notices are read on the dashboard, and the
      // topbar bell is how a member finds new ones. /portal/announcements
      // redirects there (next.config.ts).
      // Placed under More rather than in the tab bar: useful, but not one of
      // the four things a member opens the app to do. Gated on the key its
      // route checks, so staff are not offered an assistant that 403s.
      {
        href: '/portal/assistant',
        label: 'Ask the Gym',
        icon: IconChat,
        permission: PERMISSIONS.AI_CHAT_USE,
      },
      // feat/member-account: email, password, height, weight, medical notes.
      // A member's own section (coaches are not members here, owner
      // 2026-10-06), so it carries the member's key; `/me/profile` itself is
      // keyless and hard-coded to the caller. Also reached from the topbar
      // avatar.
      {
        href: '/portal/account',
        label: 'My Account',
        icon: IconGear,
        permission: PERMISSIONS.MEMBERSHIP_SELF,
      },
    ],
  },
];

/**
 * The phone tab bar's candidates, in thumb order. `visibleTabs` shows the
 * first four this caller can use — the fifth column is More. A member gets
 * Workouts (Plan lives in More since feat/member-workouts); a coach gets
 * their clients and messages.
 */
export const TAB_ITEMS: NavItem[] = [
  { href: '/portal/dashboard', label: 'Home', icon: IconDashboard },
  { href: '/portal/schedule', label: 'Classes', icon: IconCalendar },
  {
    href: '/portal/checkin',
    label: 'Check In',
    icon: IconQr,
    permission: PERMISSIONS.MEMBERSHIP_SELF,
  },
  // feat/member-workouts, owner decision: Workouts is a member's fourth tab
  // and Plan (the subscription) moves to More.
  {
    href: '/portal/workouts',
    label: 'Workouts',
    icon: IconDumbbell,
    permission: PERMISSIONS.WORKOUT_MEMBER,
  },
  {
    href: '/portal/subscription',
    label: 'Plan',
    icon: IconCard,
    permission: PERMISSIONS.MEMBERSHIP_SELF,
  },
  // A coach holds none of the member keys above, so their bar is Home,
  // Classes, Clients and Messages — the coach's whole job, in thumb order.
  {
    href: '/portal/coaching/clients',
    label: 'Clients',
    icon: IconUserPlus,
    permission: PERMISSIONS.COACH_READ,
    activeFor: ['/portal/coaching/members'],
  },
  {
    href: '/portal/coaching/messages',
    label: 'Messages',
    icon: IconChat,
    permission: PERMISSIONS.COACH_READ,
    requiresAlso: [PERMISSIONS.CHAT_USE],
    badge: 'chatAsCoach',
  },
];

const TAB_SLOTS = 4;

const ALL_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function titleForPath(pathname: string): string {
  // The same "longest match" rule as the lit nav row, so the title and the
  // highlight always name the same section — a client's page is My Clients.
  const href = activeHref(pathname, ALL_ITEMS);
  return ALL_ITEMS.find((item) => item.href === href)?.label ?? 'Portal';
}

/**
 * Only the groups with at least one item this caller can use.
 *
 * Items with no `permission` are always kept. `permissions` is `null` while
 * `/me` is still in flight, and an unresolved permission set hides the gated
 * items rather than flashing them: a nav row that appears and then vanishes
 * reads as a bug, and the member who was never going to see it loses nothing
 * by waiting. Scope-aware through `hasPermission`, like every other gate.
 */
export function visibleNav(permissions: PermissionSet): NavGroup[] {
  return filterNavGroups(NAV_GROUPS, permissions);
}

/** The tab bar: the first four candidates this caller can use. */
export function visibleTabs(permissions: PermissionSet): NavItem[] {
  return filterNavItems(TAB_ITEMS, permissions).slice(0, TAB_SLOTS);
}
