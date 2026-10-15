import { describe, expect, it } from 'vitest';
import {
  COACH_HOME,
  DESK_HOME,
  MEMBER_HOME,
  STAFF_HOME,
  canOpen,
  destinationFor,
  homeFor,
  isCoach,
  isStaff,
  portalHomeFor,
  safeNext,
} from './safeNext';

const FALLBACK = MEMBER_HOME;

describe('safeNext', () => {
  it.each([
    ['/portal/checkin', '/portal/checkin'],
    ['/portal/subscription?tab=invoices', '/portal/subscription?tab=invoices'],
    ['/portal', '/portal'],
  ])('keeps the in-portal destination %p', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  /**
   * THIS IS THE REGRESSION TEST FOR A REAL BUG, and the previous version of
   * this file asserted the opposite.
   *
   * The admin console redirects an unauthenticated caller to
   * `/login?next=/admin/members`. While `/admin` was outside the allowlist
   * that `next` was rewritten to the member portal — so a staff account could
   * never reach the console by being SENT there. Sign in, land on the member
   * portal, and reasonably conclude the two surfaces are the same product.
   */
  it.each([
    ['/admin', '/admin'],
    ['/admin/members', '/admin/members'],
    ['/admin/attendance?since=x', '/admin/attendance?since=x'],
    ['/desk/station', '/desk/station'],
  ])('keeps the staff destination %p', (raw, expected) => {
    expect(safeNext(raw)).toBe(expected);
  });

  it.each([
    ['//evil.example', 'protocol-relative URL'],
    ['/\\evil.example', 'browsers normalise the backslash into //'],
    ['\\\\evil.example', 'UNC-shaped, normalised the same way'],
    ['https://evil.example', 'absolute URL'],
    ['http://evil.example/portal/dashboard', 'absolute URL wearing a portal path'],
    ['/', 'the landing page is not a signed-in destination'],
    ['/login', 'bouncing back to the form is a loop, not a destination'],
    ['/portalish/secrets', 'a prefix match is not a path-segment match'],
    ['/adminish/secrets', 'the same, for the console'],
    ['/portal/../evil', 'a .. segment normalises outside the allowed root'],
    ['/admin/../../evil', 'the same, from the console'],
    ['portal/dashboard', 'relative, so the browser would resolve it against /login'],
    ['', 'empty'],
  ])('falls back for %p (%s)', (raw) => {
    expect(safeNext(raw)).toBe(FALLBACK);
  });

  it('falls back for null', () => {
    expect(safeNext(null)).toBe(FALLBACK);
  });

  it('accepts a caller-supplied fallback, so staff are not sent to the portal', () => {
    expect(safeNext(null, STAFF_HOME)).toBe(STAFF_HOME);
    expect(safeNext('https://evil.example', STAFF_HOME)).toBe(STAFF_HOME);
  });
});

/**
 * Staff-ness is a PERMISSION, never a role.
 *
 * A role test hard-codes today's grant table into the client and stops
 * agreeing with it the first time a grant is edited — a front-desk account
 * given `member.read` would still be sent to the member portal, and nobody
 * would know why. `member.read` is the same key the console's own layout gates
 * on, so the redirect and the shell cannot disagree.
 */
describe('isStaff / homeFor', () => {
  const held = (...keys: string[]): { key: string }[] => keys.map((key) => ({ key }));

  it('treats anyone holding member.read as staff', () => {
    expect(isStaff(held('member.read'))).toBe(true);
    expect(isStaff(held('checkin.read', 'member.read', 'payment.read'))).toBe(true);
  });

  it('does not treat a member as staff', () => {
    // Exactly what a CLIENT holds today.
    expect(isStaff(held('checkin.self', 'plan.read', 'announcement.read'))).toBe(false);
    expect(isStaff([])).toBe(false);
  });

  it('sends each of them to their own home', () => {
    expect(homeFor(held('member.read'))).toBe(STAFF_HOME);
    expect(homeFor(held('checkin.self'))).toBe(MEMBER_HOME);
  });
});

/**
 * SCOPE, AND THE COACH THIS USED TO MISCLASSIFY.
 *
 * `permission-registry.ts:251` grants COACH `member.read` at scope OWN so they
 * can read their own profile. Every scope-blind key test therefore called every
 * coach staff: routed to `/admin`, handed the console shell, and shown a
 * dashboard firing calls their grants cannot satisfy.
 *
 * The absent-scope case pins the DIRECTION of the degradation, and it is the
 * reason this is `!== 'OWN'` rather than `=== 'ALL'`. If a presenter refactor
 * ever stops sending `scope`, staff must stay staff. The opposite default would
 * demote every admin to the member portal — the exact bug this file exists to
 * prevent, arriving from the other side.
 */
describe('isStaff — scope', () => {
  it('does not treat a coach as staff (member.read at OWN)', () => {
    expect(isStaff([{ key: 'member.read', scope: 'OWN' }])).toBe(false);
    expect(
      isStaff([
        { key: 'class.read', scope: 'ALL' },
        { key: 'booking.attend', scope: 'ALL' },
        { key: 'member.read', scope: 'OWN' },
      ]),
    ).toBe(false);
  });

  it('treats member.read at ALL as staff', () => {
    expect(isStaff([{ key: 'member.read', scope: 'ALL' }])).toBe(true);
  });

  it('treats a missing scope as staff, so the failure leans the safe way', () => {
    expect(isStaff([{ key: 'member.read' }])).toBe(true);
  });

  it('sends a coach to the member portal, not the console', () => {
    expect(homeFor([{ key: 'member.read', scope: 'OWN' }])).toBe(MEMBER_HOME);
  });
});

/**
 * `destinationFor` is the whole login redirect in one function.
 *
 * THE BUG IT CLOSES: `LoginPage` computed `next = safeNext(requested)`, which
 * returns MEMBER_HOME when nothing was requested, then stamped that onto its
 * own "CREATE A MEMBER ACCOUNT" link. `RegisterPage`'s BACK TO LOGIN handed it
 * straight back as `?next=/portal/dashboard`, and a `requested !== null`
 * short-circuit made it beat `homeFor()`. So an ADMIN who so much as glanced at
 * the register screen was sent to the member portal — by a link the login
 * screen generated itself, with no `?next=` anywhere in sight.
 */
describe('canOpen / destinationFor', () => {
  const ADMIN = [{ key: 'member.read', scope: 'ALL' }];
  const FRONT_DESK = [
    { key: 'member.read', scope: 'ALL' },
    { key: 'checkin.create', scope: 'ALL' },
  ];
  // What the registry grants COACH, trimmed to the keys that decide routing.
  const COACH = [
    { key: 'class.read', scope: 'ALL' },
    { key: 'member.read', scope: 'OWN' },
    { key: 'coach.read', scope: 'OWN' },
  ];
  const CLIENT = [{ key: 'checkin.self', scope: 'OWN' }];

  it('falls to the caller-appropriate home when nothing was requested', () => {
    expect(destinationFor(null, ADMIN)).toBe(STAFF_HOME);
    expect(destinationFor('', ADMIN)).toBe(STAFF_HOME);
    expect(destinationFor(null, CLIENT)).toBe(MEMBER_HOME);
    expect(destinationFor(null, COACH)).toBe(COACH_HOME);
  });

  it('honours a staff destination the caller may actually open', () => {
    expect(destinationFor('/admin/members', ADMIN)).toBe('/admin/members');
    expect(destinationFor('/desk/station', FRONT_DESK)).toBe(DESK_HOME);
  });

  /**
   * THE REGRESSION TEST FOR THE FIX THAT DID NOT WORK THE FIRST TIME.
   *
   * `portal/layout.tsx` bounces a signed-out visitor to
   * `/login?next=/portal/dashboard`. Nobody asked for that destination — it is
   * a breadcrumb from whichever tab was open. The portal requires no
   * permission, so a permission check alone waves it through, and an ADMIN
   * lands back on the member dashboard after signing in. Confirmed live: /me
   * returned ADMIN with member.read@ALL and the topbar rendered the staff
   * switch, so detection was right and only the destination was wrong.
   */
  it('never delivers staff to the member portal by ?next=', () => {
    expect(destinationFor('/portal/dashboard', ADMIN)).toBe(STAFF_HOME);
    expect(destinationFor('/portal/subscription', ADMIN)).toBe(STAFF_HOME);
    expect(destinationFor('/portal', FRONT_DESK)).toBe(STAFF_HOME);
  });

  it('still delivers members to the portal destination they asked for', () => {
    expect(destinationFor('/portal/subscription', CLIENT)).toBe('/portal/subscription');
    // A coach is a member here, so the same rule applies to them.
    expect(destinationFor('/portal/subscription', COACH)).toBe('/portal/subscription');
  });

  it('refuses a destination the caller would be 403ed from', () => {
    expect(destinationFor('/admin/members', CLIENT)).toBe(MEMBER_HOME);
    expect(destinationFor('/admin', COACH)).toBe(COACH_HOME);
  });

  /**
   * The station display is bolted to a wall and has no auth gate of its own —
   * it authenticates as a STATION, not as a person. A member handed this link
   * used to be routed onto the lobby screen.
   */
  it('does not route a member onto the wall-mounted station display', () => {
    expect(destinationFor('/desk/station', CLIENT)).toBe(MEMBER_HOME);
    expect(destinationFor('/desk/station', ADMIN)).toBe(STAFF_HOME);
  });

  it('still rejects an unsafe next before permission is even considered', () => {
    expect(destinationFor('https://evil.example', ADMIN)).toBe(STAFF_HOME);
    expect(destinationFor('//evil.example', CLIENT)).toBe(MEMBER_HOME);
  });

  it('canOpen says no to anything outside a known surface', () => {
    expect(canOpen('/', ADMIN)).toBe(false);
    expect(canOpen('/login', ADMIN)).toBe(false);
    expect(canOpen('/portal/dashboard', CLIENT)).toBe(true);
  });
});

/**
 * COACHES LAND ON THE COACH DASHBOARD — decided by permission, never by role.
 *
 * A coach is somebody who holds `coach.read` (at OWN, per the registry) and is
 * not staff. Staff hold `coach.read` at ALL as well, but they are going to the
 * console, so the staff test runs first. A role test here would stop agreeing
 * with the grant table the first time a grant is edited.
 */
describe('coach landing', () => {
  const COACH = [
    { key: 'member.read', scope: 'OWN' },
    { key: 'coach.read', scope: 'OWN' },
    { key: 'progress.read', scope: 'OWN' },
  ];
  const ADMIN = [
    { key: 'member.read', scope: 'ALL' },
    { key: 'coach.read', scope: 'ALL' },
  ];
  const CLIENT = [
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'coach.self', scope: 'OWN' },
  ];

  it('knows a coach by coach.read, and never calls staff or a member one', () => {
    expect(isCoach(COACH)).toBe(true);
    expect(isCoach(ADMIN)).toBe(false);
    expect(isCoach(CLIENT)).toBe(false);
    expect(isCoach([])).toBe(false);
  });

  it('sends a coach home to the dashboard, which renders the coach view for them', () => {
    expect(COACH_HOME).toBe('/portal/dashboard');
    expect(homeFor(COACH)).toBe(COACH_HOME);
    expect(destinationFor(null, COACH)).toBe(COACH_HOME);
  });

  it('still sends staff to the console and members to their dashboard', () => {
    expect(homeFor(ADMIN)).toBe(STAFF_HOME);
    expect(homeFor(CLIENT)).toBe(MEMBER_HOME);
  });

  it("honours a coach's own ?next= inside the portal", () => {
    expect(destinationFor('/portal/schedule', COACH)).toBe('/portal/schedule');
    expect(destinationFor('/portal/coaching/members/x', COACH)).toBe('/portal/coaching/members/x');
  });

  it('names the portal home for each caller, for "go home" links inside the portal', () => {
    expect(portalHomeFor(COACH)).toBe(COACH_HOME);
    expect(portalHomeFor(CLIENT)).toBe(MEMBER_HOME);
    // Staff visiting the portal have the member dashboard as its home; their
    // console is one SurfaceSwitch away.
    expect(portalHomeFor(ADMIN)).toBe(MEMBER_HOME);
    expect(portalHomeFor(null)).toBe(MEMBER_HOME);
  });
});

// ── Staff & Access: the invite page's "sign in instead" ──────────────────────
describe('the invite page as a ?next= destination', () => {
  const ADMIN = [{ key: 'member.read', scope: 'ALL' }];
  const CLIENT = [{ key: 'checkin.self', scope: 'OWN' }];

  it('is a real destination, so signing in comes back to the invitation', () => {
    expect(safeNext('/invite/abc_DEF-123')).toBe('/invite/abc_DEF-123');
  });

  it('delivers a member AND a staff account back to it — accepting needs no permission', () => {
    expect(destinationFor('/invite/abc', CLIENT)).toBe('/invite/abc');
    expect(destinationFor('/invite/abc', ADMIN)).toBe('/invite/abc');
  });

  it('is never anybody’s home', () => {
    expect(homeFor(CLIENT)).toBe(MEMBER_HOME);
    expect(homeFor(ADMIN)).toBe(STAFF_HOME);
  });

  it('still refuses a prefix that is not the invite page', () => {
    expect(safeNext('/invitefoo')).toBe(MEMBER_HOME);
    expect(safeNext('/invite/../admin')).toBe(MEMBER_HOME);
  });
});
