import { describe, expect, it } from 'vitest';
import {
  ADMIN_NAV,
  adminNavItemForPath,
  primaryTabs,
  visibleNav as adminVisibleNav,
} from '@/components/admin/nav';
import { titleForPath, visibleNav as portalVisibleNav, visibleTabs } from '@/components/portal/nav';
import { canSee, filterNavGroups, filterNavItems } from './nav';
import {
  ADMIN_PERMISSIONS,
  CLIENT_PERMISSIONS,
  COACH_PERMISSIONS,
  DEV_PERMISSIONS,
  FRONT_DESK_PERMISSIONS,
} from './roleFixtures';

describe('canSee', () => {
  const COACH = [{ key: 'member.read', scope: 'OWN' }];

  it('always shows an ungated item, even while /me is loading', () => {
    expect(canSee({}, null)).toBe(true);
    expect(canSee({}, [])).toBe(true);
  });

  it('hides a gated item while /me is loading', () => {
    expect(canSee({ permission: 'member.read' }, null)).toBe(false);
  });

  it("uses the item's own scope, then the caller's default", () => {
    expect(canSee({ permission: 'member.read' }, COACH)).toBe(true);
    expect(canSee({ permission: 'member.read', scope: 'ALL' }, COACH)).toBe(false);
    expect(canSee({ permission: 'member.read' }, COACH, 'ALL')).toBe(false);
    expect(canSee({ permission: 'member.read', scope: 'OWN' }, COACH, 'ALL')).toBe(true);
  });

  // feat/coach-tools: the coach's Messages inbox needs the coaching key AND
  // chat.use — an admin holds coach.read and is not a party to any chat.
  it('requires every key in requiresAlso, at any scope', () => {
    const gate = { permission: 'coach.read', requiresAlso: ['chat.use'] };
    expect(canSee(gate, [{ key: 'coach.read', scope: 'ALL' }])).toBe(false);
    expect(canSee(gate, [{ key: 'chat.use', scope: 'OWN' }])).toBe(false);
    expect(
      canSee(gate, [
        { key: 'coach.read', scope: 'OWN' },
        { key: 'chat.use', scope: 'OWN' },
      ]),
    ).toBe(true);
    expect(canSee(gate, null)).toBe(false);
  });
});

describe('filterNavItems / filterNavGroups', () => {
  const groups = [
    { heading: 'A', items: [{ href: '/a' }, { href: '/b', permission: 'x.read' }] },
    { heading: 'B', items: [{ href: '/c', permission: 'y.read' }] },
  ];

  it('keeps what the caller can use and drops a group left empty', () => {
    expect(filterNavGroups(groups, [{ key: 'x.read', scope: 'ALL' }])).toEqual([groups[0]]);
    expect(filterNavGroups(groups, [])).toEqual([{ heading: 'A', items: [{ href: '/a' }] }]);
  });

  it('filters a flat list the same way', () => {
    expect(filterNavItems(groups[0].items, [])).toEqual([{ href: '/a' }]);
  });
});

const labels = (groups: readonly { heading: string; items: readonly { label: string }[] }[]) =>
  Object.fromEntries(groups.map((group) => [group.heading, group.items.map((i) => i.label)]));

/**
 * THE PORTAL NAV, ROLE BY ROLE — the owner's decisions of 2026-09-25.
 *
 * Coaches, the desk and admins are not members here, so My Subscription,
 * Pay / GCash, My Progress and My Coach are CLIENT-only (`*.self` keys). A
 * coach's "My Coach" becomes "My Clients", and "Ask the Gym" needs
 * `ai.chat.use`.
 */
describe('portal nav', () => {
  // feat/member-workouts: Workouts sits right after Dashboard, gated on
  // `workout.member`, which only CLIENT holds.
  it('shows a member their own sections and no coaching', () => {
    expect(labels(portalVisibleNav(CLIENT_PERMISSIONS))).toEqual({
      Main: ['Dashboard', 'Workouts', 'Class Schedule', 'My Bookings', 'Check-in History'],
      Membership: ['My Subscription', 'Pay / GCash'],
      More: ['Check In', 'My Progress', 'My Coach', 'Ask the Gym', 'My Account'],
    });
  });

  // Owner, 2026-10-06: "the coach to be a coach only". One Dashboard (the
  // coach view renders there), no second Coach Dashboard row, and none of a
  // member's own bookings, visits or check-in.
  it('shows a coach one dashboard, their coaching sections and no member sections', () => {
    expect(labels(portalVisibleNav(COACH_PERMISSIONS))).toEqual({
      Main: ['Dashboard', 'Class Schedule'],
      Coaching: ['My Clients', 'Messages'],
    });
  });

  // feat/coach-tools: My Clients is its own hub now, and Messages is the inbox.
  it('points My Clients at the clients hub and Messages at the inbox', () => {
    const coaching = portalVisibleNav(COACH_PERMISSIONS).find((g) => g.heading === 'Coaching');
    expect(coaching?.items.find((i) => i.label === 'My Clients')?.href).toBe(
      '/portal/coaching/clients',
    );
    expect(coaching?.items.find((i) => i.label === 'Messages')?.href).toBe(
      '/portal/coaching/messages',
    );
  });

  it('gives an admin in the portal the coaching screens but no Messages — no chat.use', () => {
    const coaching = portalVisibleNav(ADMIN_PERMISSIONS).find((g) => g.heading === 'Coaching');
    expect(coaching?.items.map((i) => i.label)).toEqual(['My Clients']);
  });

  it('shows front desk only the ungated portal sections', () => {
    expect(labels(portalVisibleNav(FRONT_DESK_PERMISSIONS))).toEqual({
      Main: ['Dashboard', 'Class Schedule'],
    });
  });

  it('shows the Super Admin everything', () => {
    expect(labels(portalVisibleNav(DEV_PERMISSIONS))).toEqual({
      Main: ['Dashboard', 'Workouts', 'Class Schedule', 'My Bookings', 'Check-in History'],
      Membership: ['My Subscription', 'Pay / GCash'],
      Coaching: ['My Clients', 'Messages'],
      More: ['Check In', 'My Progress', 'My Coach', 'Ask the Gym', 'My Account'],
    });
  });

  it('hides every gated section while /me is loading', () => {
    expect(labels(portalVisibleNav(null))).toEqual({
      Main: ['Dashboard', 'Class Schedule'],
    });
  });

  // feat/member-account: the member's own email, password and body numbers.
  it('points My Account at the account page and titles it', () => {
    const more = portalVisibleNav(CLIENT_PERMISSIONS).find((g) => g.heading === 'More');
    expect(more?.items.find((i) => i.label === 'My Account')?.href).toBe('/portal/account');
    expect(titleForPath('/portal/account')).toBe('My Account');
  });

  it("titles a client's own page after My Clients, which it was reached from", () => {
    expect(titleForPath('/portal/coaching/members/u1')).toBe('My Clients');
    expect(titleForPath('/portal/coaching/messages')).toBe('Messages');
  });
});

describe('portal tab bar', () => {
  const tabs = (perms: Parameters<typeof visibleTabs>[0]) => visibleTabs(perms).map((t) => t.label);

  // feat/member-workouts: Workouts is the member's fourth tab; Plan (the
  // subscription) moves to More. A coach gets their clients and messages.
  it('gives a member Workouts and a coach Clients and Messages', () => {
    expect(tabs(CLIENT_PERMISSIONS)).toEqual(['Home', 'Classes', 'Check In', 'Workouts']);
    expect(tabs(COACH_PERMISSIONS)).toEqual(['Home', 'Classes', 'Clients', 'Messages']);
  });

  it('moves Plan to More for a member — still in the nav, no longer a tab', () => {
    expect(tabs(CLIENT_PERMISSIONS)).not.toContain('Plan');
    const membership = portalVisibleNav(CLIENT_PERMISSIONS).find((g) => g.heading === 'Membership');
    expect(membership?.items.map((i) => i.href)).toContain('/portal/subscription');
  });

  it('points Workouts at the hub, and titles its child routes after it', () => {
    expect(visibleTabs(CLIENT_PERMISSIONS).find((t) => t.label === 'Workouts')?.href).toBe(
      '/portal/workouts',
    );
    expect(titleForPath('/portal/workouts/new')).toBe('Workouts');
    expect(titleForPath('/portal/workouts/abc')).toBe('Workouts');
  });

  it('never offers a tab the caller cannot use', () => {
    expect(tabs(FRONT_DESK_PERMISSIONS)).toEqual(['Home', 'Classes']);
    expect(tabs(null)).toEqual(['Home', 'Classes']);
  });

  it('holds at most four tabs — the fifth column is More', () => {
    expect(tabs(DEV_PERMISSIONS)).toEqual(['Home', 'Classes', 'Check In', 'Workouts']);
  });
});

/**
 * THE CONSOLE NAV, ROLE BY ROLE.
 *
 * Front desk loses Revenue (now a Reports tab behind `revenue.read`) and the
 * admin Announcements tab (`announcement.create`), and keeps Reports.
 */
describe('admin nav', () => {
  it('shows front desk the desk screens, Reports, and no Revenue or Announcements', () => {
    expect(labels(adminVisibleNav(FRONT_DESK_PERMISSIONS))).toEqual({
      Overview: ['Dashboard', 'Notifications'],
      Members: ['Members', 'Leads', 'Attendance', 'Walk-ins'],
      Finance: ['Payments', 'Reports'],
      System: ['Classes', 'Settings'],
    });
  });

  it('shows an admin every screen', () => {
    expect(labels(adminVisibleNav(ADMIN_PERMISSIONS))).toEqual({
      Overview: ['Dashboard', 'Notifications'],
      Members: ['Members', 'Leads', 'Attendance', 'Walk-ins'],
      Finance: ['Payments', 'Reports'],
      System: [
        'Classes',
        'Coaches',
        'Stations',
        'Announcements',
        'Staff & Access',
        'Audit Logs',
        'Settings',
      ],
    });
  });

  // Staff & Access: `staff.invite` is ADMIN's (and DEV's through the bypass).
  it('shows Staff & Access to admins and the Super Admin, and to nobody else', () => {
    const has = (permissions: Parameters<typeof adminVisibleNav>[0]) =>
      adminVisibleNav(permissions)
        .flatMap((group) => group.items)
        .some((item) => item.href === '/admin/staff');
    expect(has(ADMIN_PERMISSIONS)).toBe(true);
    expect(has(DEV_PERMISSIONS)).toBe(true);
    expect(has(FRONT_DESK_PERMISSIONS)).toBe(false);
    expect(has(COACH_PERMISSIONS)).toBe(false);
    expect(adminNavItemForPath('/admin/staff')?.permission).toBe('staff.invite');
  });

  it('has no Revenue item any more — /admin/revenue redirects into Reports', () => {
    const hrefs = ADMIN_NAV.flatMap((group) => group.items.map((item) => item.href));
    expect(hrefs).not.toContain('/admin/revenue');
  });

  /**
   * Every console screen lists other people, so an OWN grant opens none of
   * them. A coach's member.read, checkin.read and coach.read are all OWN.
   */
  it('gives an OWN-only grant no console screen', () => {
    const coachScreens = adminVisibleNav(COACH_PERMISSIONS).flatMap((g) => g.items);
    for (const item of coachScreens) {
      expect(COACH_PERMISSIONS.find((p) => p.key === item.permission)?.scope).toBe('ALL');
    }
    expect(coachScreens.map((i) => i.label)).not.toContain('Attendance');
    expect(coachScreens.map((i) => i.label)).not.toContain('Coaches');
    expect(coachScreens.map((i) => i.label)).not.toContain('Dashboard');
  });

  /**
   * The console guards a screen opened by URL with the same rule its nav item
   * uses, so "hidden from the nav" and "not for your role" can never
   * disagree.
   */
  it('finds the nav item that owns a path, child routes included', () => {
    expect(adminNavItemForPath('/admin')?.label).toBe('Dashboard');
    expect(adminNavItemForPath('/admin/stations')?.label).toBe('Stations');
    expect(adminNavItemForPath('/admin/members/abc')?.label).toBe('Members');
    expect(adminNavItemForPath('/admin/coaches/xyz')?.label).toBe('Coaches');
    expect(adminNavItemForPath('/admin/unknown')?.label).toBe('Dashboard');
  });

  it('refuses front desk the screens its nav hides, and allows the rest', () => {
    const allowed = (path: string) => {
      const item = adminNavItemForPath(path);
      return item === undefined || canSee(item, FRONT_DESK_PERMISSIONS, 'ALL');
    };
    expect(allowed('/admin/stations')).toBe(false);
    expect(allowed('/admin/audit')).toBe(false);
    expect(allowed('/admin/coaches')).toBe(false);
    expect(allowed('/admin/announcements')).toBe(false);
    expect(allowed('/admin/reports')).toBe(true);
    expect(allowed('/admin/members/abc')).toBe(true);
    expect(allowed('/admin')).toBe(true);
  });

  it('filters the bottom tabs through the same result', () => {
    expect(primaryTabs(adminVisibleNav(FRONT_DESK_PERMISSIONS)).map((t) => t.label)).toEqual([
      'Dashboard',
      'Members',
      'Attendance',
      'Payments',
    ]);
    expect(primaryTabs(adminVisibleNav(null))).toEqual([]);
  });
});
