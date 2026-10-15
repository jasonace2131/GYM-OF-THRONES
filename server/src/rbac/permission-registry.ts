import type { PermissionScope, Role } from '@prisma/client';

export interface PermissionDefinition {
  key: string;
  resource: string;
  action: string;
  description: string;
  isDangerous: boolean;
  requires: string[];
}

/** One default grant in ROLE_PERMISSIONS: a catalogue key plus its reach. */
export interface PermissionGrant {
  key: string;
  scope: PermissionScope;
}

/**
 * Splits a permission key into its resource and action.
 *
 * Keys are `resource.action` or `resource.sub.action` — the resource is
 * everything before the first dot, the action is everything after the last.
 */
export function deriveResourceAction(key: string): { resource: string; action: string } {
  const parts = key.split('.');
  return { resource: parts[0], action: parts[parts.length - 1] };
}

function define(
  key: string,
  description: string,
  options: { isDangerous?: boolean; requires?: string[] } = {},
): PermissionDefinition {
  // Guards the catalogue below, not `deriveResourceAction` — that stays a
  // pure splitter. A dotless key would otherwise yield resource === action
  // and pass silently.
  if (!key.includes('.')) {
    throw new Error(`Permission key "${key}" must be "resource.action" or "resource.sub.action"`);
  }
  const { resource, action } = deriveResourceAction(key);
  return {
    key,
    resource,
    action,
    description,
    isDangerous: options.isDangerous ?? false,
    requires: options.requires ?? [],
  };
}

/**
 * The canonical permission catalogue — seeded into the database by
 * `prisma/seed.ts` and never created any other way. See §9 of the RBAC
 * design doc.
 *
 * `ai.*` keys are reserved for the AI fitness assistant, which has not
 * shipped yet — seeding them now means the assistant attaches to an
 * existing permission surface instead of inventing one later.
 */
export const PERMISSION_CATALOGUE: PermissionDefinition[] = [
  define('member.read', 'View member profiles'),
  define('member.create', 'Create a member', { requires: ['member.read'] }),
  define('member.update', 'Edit a member profile', { requires: ['member.read'] }),
  define('member.suspend', 'Suspend a member account', { requires: ['member.read'] }),
  define('member.delete', 'Delete a member', { isDangerous: true, requires: ['member.read'] }),

  define('plan.read', 'View the published price list'),
  define('plan.manage', 'Create, edit and archive plans', { requires: ['plan.read'] }),

  // `requires: ['member.read']` because the only screen that renders a
  // membership is now the member roster — `/admin/subscriptions` merged into
  // `/admin/members`, so a grant of this key without `member.read` produces a
  // caller who can read memberships and reach no screen that shows one.
  //
  // Honest about what this buys: `requires` is CATALOGUE METADATA surfaced on
  // the permissions admin screen. It is NOT enforced at grant time, so this
  // stops nobody from making that grant — it only tells the person making it
  // what they are actually building. All four seeded roles already satisfy
  // it (permission-registry's own grant table, FRONT_DESK/COACH/ADMIN).
  define('membership.read', 'View memberships', { requires: ['member.read'] }),
  define('membership.sell', 'Sell or renew a membership', {
    requires: ['membership.read', 'payment.record'],
  }),
  define('membership.cancel.request', 'Record or withdraw notice of cancellation', {
    requires: ['membership.read'],
  }),
  // ADMIN only, deliberately not FRONT_DESK: this is what moves the "no" off
  // the desk staff and onto the owner.
  define('membership.freeze', 'Freeze or release a membership', {
    requires: ['membership.read'],
  }),
  define('membership.cancel', 'Terminate a membership', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.term.adjust', 'Move a term end date — comp days and closures', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.status.correct', 'Override the membership transition table', {
    isDangerous: true,
    requires: ['membership.read'],
  }),
  define('membership.import', 'Load the legacy member base', {
    isDangerous: true,
    requires: ['membership.read', 'member.create'],
  }),

  define('payment.read', 'View payments'),
  define('payment.record', 'Record a payment'),
  // Statutory and mandatory (RA 9994 / RA 10754), so the desk must be able to
  // ring it without a manager or the till never reconciles.
  define('payment.discount.statutory', 'Apply a senior-citizen or PWD discount', {
    requires: ['payment.record'],
  }),
  define('payment.discount.grant', 'Apply a discretionary discount', {
    requires: ['payment.record'],
  }),
  define('payment.void', 'Void a recorded payment', {
    isDangerous: true,
    requires: ['payment.read', 'payment.record'],
  }),
  // NOT a reuse of payment.void. An amend can RAISE a figure; a void can only
  // remove one. Naming payment.void as a prerequisite says amend is strictly
  // more than void, and makes assertRequiresClosure fail the seed loudly if a
  // role is ever given the correction without the reversal underneath it.
  define('payment.amend', 'Correct a recorded payment by voiding and re-recording it', {
    isDangerous: true,
    requires: ['payment.read', 'payment.record', 'payment.void'],
  }),
  // Deliberately NOT dangerous: archiving hides a row from the register and
  // changes no figure anywhere — no report, shift closure or BIR register
  // reads `archivedAt`, exactly as none of them reads `User.deletedAt`.
  define('payment.archive', 'Hide a payment from the register without changing any figure', {
    requires: ['payment.read'],
  }),
  define('shift.manage', 'Open and close the cash drawer', { requires: ['payment.read'] }),
  // Owner decision (2026-09-25): the front desk loses Revenue and keeps
  // Reports exactly as it is, peso figures included. So revenue is its own key
  // ON TOP of payment.read rather than a replacement for it — the desk still
  // needs payment.read for the till, the GCash queue, receipts and Reports.
  define('revenue.read', 'View revenue over time and recurring revenue (MRR, churn)', {
    requires: ['payment.read'],
  }),

  define('job.run', 'Trigger a scheduled job by hand', { isDangerous: true }),

  define('checkin.self', 'Check in by scanning the counter QR'),
  define('checkin.read', 'View check-in records'),
  // Reworded: its old text, "Check a member in manually", is no longer the
  // whole of what it covers.
  define('checkin.create', "Record a check-in on a member's behalf (member code or manual)", {
    requires: ['checkin.read'],
  }),
  define('checkin.close', 'Check a member out from the desk', { requires: ['checkin.create'] }),
  // A void rewrites somebody's attendance record. ADMIN only, and confirmed.
  define('checkin.void', 'Void a recorded check-in', {
    isDangerous: true,
    requires: ['checkin.read'],
  }),
  // Admitting someone the door refused. ADMIN only.
  define('checkin.override', 'Admit a member the door turned away', {
    isDangerous: true,
    requires: ['checkin.create'],
  }),
  // THE ONE COMPOSITE KEY. This endpoint both takes money and admits
  // somebody, and @RequirePermission takes exactly one key — so the
  // prerequisites ride on `requires` rather than the guard growing a
  // "require any of" variant it could not resolve a scope from.
  define('walkin.sell', 'Sell a walk-in or use a guest pass', {
    requires: ['payment.record', 'checkin.create'],
  }),
  define('checkin.station_token.issue', 'Render the counter check-in QR'),
  // ADMIN only, and isDangerous: two of its three actions take a check-in
  // point offline, one of them instantly for every member walking towards it.
  define('station.manage', 'Manage check-in stations and their tablets', { isDangerous: true }),

  define('coach.read', 'View coach assignments'),
  define('coach.assign', 'Assign a member to a coach', { requires: ['coach.read'] }),
  define('coach.update', 'Edit a coach assignment', { requires: ['coach.read'] }),

  // ── Staff & Access: coach profiles ─────────────────────────────────────
  // What members read about a coach (specializations, a short bio). Its own
  // key rather than `coach.update`, which is about ASSIGNMENTS: editing who a
  // coach coaches and editing what the public reads about them are different
  // jobs, and a role could reasonably hold one without the other.
  define('coach.profile.update', "Edit a coach's profile — specializations and bio", {
    requires: ['coach.read'],
  }),
  // ── end Staff & Access: coach profiles ─────────────────────────────────

  // ── Coach-recorded progress ────────────────────────────────────────────
  //
  // Owner decision: a member's measurements and goals are recorded by their
  // ASSIGNED coach, and by nobody else — not admins, not the desk. Granted to
  // COACH at OWN only, and OWN on these routes resolves through the
  // `coachedMember` scope, which has no self branch: a coach reaches the
  // members actively assigned to them and never their own row. Nobody holds
  // either key at ALL; DEV reaches them through its catalogue-wide bypass.
  define('progress.read', "View an assigned member's measurements and goals", {
    requires: ['coach.read'],
  }),
  define('progress.record', 'Record measurements and manage goals for an assigned member', {
    requires: ['progress.read'],
  }),

  define('permission.read', 'View permission grants'),
  define('permission.grant', 'Grant a permission', {
    isDangerous: true,
    requires: ['permission.read'],
  }),
  define('permission.revoke', 'Revoke a permission', { requires: ['permission.read'] }),

  define('role.read', 'View roles'),
  // Deliberately narrower than the spec's §9 table, which also lists
  // `permission.read` — changing which role a user holds does not require
  // being able to see the permission catalogue behind it.
  define('role.change', 'Change the role assigned to a user', {
    isDangerous: true,
    requires: ['role.read'],
  }),
  define('role.permissions.update', 'Edit a role default permissions', {
    requires: ['role.read', 'permission.read'],
  }),

  // ── Staff & Access: invitations ────────────────────────────────────────
  // An invitation is a role change that happens later, when somebody accepts
  // it — so it sits on top of `role.change`, and is dangerous for the same
  // reason. `member.read` because the Staff & Access screen is a roster.
  //
  // The key says who may invite AT ALL. Which roles they may invite is the
  // role hierarchy's job (`@got/shared` role-hierarchy): an ADMIN invites
  // front desk and coaches, and only DEV — which holds every key through its
  // bypass — may invite another ADMIN.
  define('staff.invite', 'Invite staff and manage pending invitations', {
    isDangerous: true,
    requires: ['member.read', 'role.change'],
  }),
  // ── end Staff & Access: invitations ────────────────────────────────────

  define('announcement.read', 'View announcements'),
  define('announcement.create', 'Post an announcement', { requires: ['announcement.read'] }),
  define('announcement.update', 'Edit an announcement', { requires: ['announcement.read'] }),
  define('announcement.delete', 'Delete an announcement', { requires: ['announcement.read'] }),

  // ── Classes and bookings ───────────────────────────────────────────────
  //
  // `class.read` is separate from `booking.create` so a gym can publish a
  // timetable to everybody while restricting who may reserve a seat — which is
  // exactly what happens when classes are a paid add-on. Today CLIENT holds
  // both.
  define('class.read', 'See the class timetable'),
  define('class.manage', 'Create, edit and cancel classes', { requires: ['class.read'] }),
  define('booking.create', 'Book a place in a class', { requires: ['class.read'] }),
  define('booking.read', 'See who is booked into a class', { requires: ['class.read'] }),
  // Marking the register is its own key: a coach may take attendance for their
  // own class without being able to edit the timetable.
  define('booking.attend', 'Mark class attendance', { requires: ['booking.read'] }),
  // The desk adding a member to a class, or taking one out, on their behalf
  // (owner, 2026-10-11: "the desk can still add someone by hand") — including
  // a walk-in joining a class that is already running. Its own key, because
  // each of the three that look close would widen somebody else's reach:
  //   - `booking.create` at ALL: the member routes ignore scope and always act
  //     on the caller, so staff could book THEMSELVES — and staff are not
  //     members here (2026-09-25);
  //   - `class.manage`: that is the timetable, not the people in it, and the
  //     front desk does not hold it;
  //   - `booking.attend`: COACH holds it at ALL, so any coach could add or
  //     remove anybody in any class.
  // `member.read` because the person being added is picked from the roster.
  define('booking.manage', 'Add a member to a class, or remove one, on their behalf', {
    requires: ['booking.read', 'member.read'],
  }),

  define('audit.read', 'View the audit log'),

  // ── Notifications ──────────────────────────────────────────────────────
  //
  // Two keys, not one. Seeing that an enquiry arrived and claiming it has been
  // dealt with are different acts, and a read-only role — an owner who wants
  // the board but does not work it — should be expressible without also being
  // able to clear it.
  define('notification.read', 'View the system notification board'),
  define('notification.resolve', 'Mark a system notification read or dealt with', {
    requires: ['notification.read'],
  }),

  define('ai.chat.use', 'Use the AI fitness assistant'),
  define('ai.chat.history.read', 'View AI assistant conversation history'),
  define('ai.admin.configure', 'Configure the AI assistant'),

  // ── The member's own portal sections ───────────────────────────────────
  //
  // Owner decision (2026-09-25): coaches, the desk and admins are not members
  // here, so My Subscription, Pay / GCash, My Progress and My Coach leave
  // their portal. These keys say who the sections are FOR. They gate the
  // portal nav and each page's guard, and nothing else: the /me/* routes
  // behind them stay keyless, hard-coded to the caller, like GET /me.
  define('membership.self', 'See your own membership and pay for it in the portal'),
  define('progress.self', 'See your own progress in the portal'),
  define('coach.self', 'See your own assigned coach in the portal'),

  // ── Coach tools (feat/coach-tools): chat and workout plans ─────────────
  //
  // `chat.use` is the conversation itself. The subject is always the caller:
  // a thread is reachable only as its coach or its member, whatever the
  // grant's scope says (src/chat/chat-access.ts). Writable only while the
  // pair has an ACTIVE assignment, and never for a member under 18.
  define('chat.use', 'Message your coach, or your assigned members, in the portal'),
  // Reading a conversation you are not part of, for a complaint. Every read is
  // audited (CHAT_THREAD_REVIEWED) with the reason given.
  define('chat.review', 'Read a coach-member conversation you are not part of'),
  // Saving an assigned member's plan. `coachedMember` scope: an ACTIVE
  // assignment to the caller, no self branch.
  define('workout.manage', "Save an assigned member's workout plan", {
    requires: ['coach.read'],
  }),
  // The AI draft. It reads the member's goals and measurements to build the
  // prompt, so it stands on progress.read as well as on the save it feeds.
  define('workout.suggest', "Ask the AI to draft an assigned member's workout plan", {
    requires: ['workout.manage', 'progress.read'],
  }),
  // The member's own "My workout plan" card.
  define('workout.self', 'See your own workout plan in the portal'),
  // Member workout planner (feat/member-workouts): the member's own AI plans and
  // the AI actions on them. Separate from the coach's plan on purpose.
  define('workout.member', 'Build and keep your own AI workout plans'),
];

/**
 * One row per (role, permission) default grant. `DEV` is deliberately
 * absent — it bypasses the catalogue entirely in `PermissionsService`
 * rather than being seeded, per §6 of the RBAC design.
 *
 * This mapping is this plan's own interpretation of each role's surface —
 * the spec fixes the catalogue keys but not this table. Adjust freely; the
 * mechanism (PermissionsService, PermissionsGuard) does not depend on the
 * specific grants below.
 */
export const ROLE_PERMISSIONS: Record<
  Exclude<Role, 'DEV'>,
  Array<{ key: string; scope: PermissionScope }>
> = {
  CLIENT: [
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'ai.chat.use', scope: 'OWN' },
    { key: 'ai.chat.history.read', scope: 'OWN' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'plan.read', scope: 'ALL' },
    { key: 'class.read', scope: 'ALL' },
    // OWN: a member books for themselves and sees their own bookings. Who ELSE
    // is in a class is `booking.read`, which they do not hold — a class list is
    // a list of members' names and times, and that is the desk's business.
    { key: 'booking.create', scope: 'OWN' },
    // The member's own portal sections — see the catalogue. OWN, and CLIENT
    // only: nobody else is a member here.
    { key: 'membership.self', scope: 'OWN' },
    { key: 'progress.self', scope: 'OWN' },
    { key: 'coach.self', scope: 'OWN' },
    // ── Coach tools (feat/coach-tools) ──
    { key: 'chat.use', scope: 'OWN' },
    { key: 'workout.self', scope: 'OWN' },
    // ── Member workout planner (feat/member-workouts) ──
    { key: 'workout.member', scope: 'OWN' },
  ],
  FRONT_DESK: [
    { key: 'class.read', scope: 'ALL' },
    { key: 'booking.read', scope: 'ALL' },
    { key: 'booking.attend', scope: 'ALL' },
    // The desk adds members to classes by hand, and takes them out (2026-10-11).
    // Not COACH: a coach marks registers, and adding or removing people is the
    // counter's job.
    { key: 'booking.manage', scope: 'ALL' },
    // Staff who train check themselves in through the member's own route
    // (§6.14.2). OWN, always — a desk operator recording someone ELSE's entry
    // goes through checkin.create, which is a different key and a different
    // accountability story.
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'checkin.read', scope: 'ALL' },
    { key: 'checkin.create', scope: 'ALL' },
    { key: 'checkin.close', scope: 'ALL' },
    { key: 'walkin.sell', scope: 'ALL' },
    { key: 'checkin.station_token.issue', scope: 'ALL' },
    { key: 'member.read', scope: 'ALL' },
    // The desk registers walk-ups. Front desk already sells the membership
    // (`membership.sell` below) — refusing them the ACCOUNT that membership
    // hangs off made the common counter flow "fetch an admin", and the
    // capstone requirement REQ005 names Admin OR Staff. `role.change` stays
    // ADMIN-only, so the desk can create members and never staff.
    { key: 'member.create', scope: 'ALL' },
    { key: 'member.update', scope: 'ALL' },
    { key: 'announcement.read', scope: 'ALL' },
    // The desk is who rings a new enquiry back, so the desk gets the board and
    // the ability to tick a notice off it. Nothing here is dangerous: a
    // notification is a reminder, and resolving one changes no money, no
    // membership and no account.
    { key: 'notification.read', scope: 'ALL' },
    { key: 'notification.resolve', scope: 'ALL' },
    { key: 'plan.read', scope: 'ALL' },
    { key: 'membership.read', scope: 'ALL' },
    { key: 'membership.sell', scope: 'ALL' },
    { key: 'membership.cancel.request', scope: 'ALL' },
    { key: 'payment.read', scope: 'ALL' },
    { key: 'payment.record', scope: 'ALL' },
    { key: 'payment.discount.statutory', scope: 'ALL' },
    { key: 'shift.manage', scope: 'ALL' },
  ],
  COACH: [
    { key: 'class.read', scope: 'ALL' },
    { key: 'booking.read', scope: 'ALL' },
    { key: 'booking.attend', scope: 'ALL' },
    { key: 'member.read', scope: 'OWN' },
    { key: 'coach.read', scope: 'OWN' },
    // OWN, and ONLY here: the member's currently assigned coach records their
    // progress. `coachedMember` scoping means a coach whose assignment ended
    // loses the member on the next request.
    { key: 'progress.read', scope: 'OWN' },
    { key: 'progress.record', scope: 'OWN' },
    // A coach training between clients across a split shift is exactly the
    // person the daily ceiling would otherwise deny (§6.5.5).
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'checkin.read', scope: 'OWN' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'ai.chat.history.read', scope: 'OWN' },
    { key: 'plan.read', scope: 'ALL' },
    { key: 'membership.read', scope: 'OWN' },
    // ── Coach tools (feat/coach-tools) ── OWN only: their assigned members.
    { key: 'chat.use', scope: 'OWN' },
    { key: 'workout.manage', scope: 'OWN' },
    { key: 'workout.suggest', scope: 'OWN' },
  ],
  ADMIN: [
    { key: 'class.read', scope: 'ALL' },
    { key: 'class.manage', scope: 'ALL' },
    { key: 'booking.read', scope: 'ALL' },
    { key: 'booking.attend', scope: 'ALL' },
    { key: 'booking.manage', scope: 'ALL' },
    { key: 'member.read', scope: 'ALL' },
    { key: 'member.create', scope: 'ALL' },
    { key: 'member.update', scope: 'ALL' },
    { key: 'member.suspend', scope: 'ALL' },
    { key: 'member.delete', scope: 'ALL' },
    { key: 'checkin.self', scope: 'OWN' },
    { key: 'checkin.read', scope: 'ALL' },
    { key: 'checkin.create', scope: 'ALL' },
    { key: 'checkin.close', scope: 'ALL' },
    { key: 'checkin.void', scope: 'ALL' },
    { key: 'checkin.override', scope: 'ALL' },
    { key: 'walkin.sell', scope: 'ALL' },
    { key: 'checkin.station_token.issue', scope: 'ALL' },
    { key: 'station.manage', scope: 'ALL' },
    { key: 'coach.read', scope: 'ALL' },
    { key: 'coach.assign', scope: 'ALL' },
    { key: 'coach.update', scope: 'ALL' },
    // ── Staff & Access ──
    { key: 'coach.profile.update', scope: 'ALL' },
    { key: 'staff.invite', scope: 'ALL' },
    // ── end Staff & Access ──
    { key: 'permission.read', scope: 'ALL' },
    { key: 'permission.grant', scope: 'ALL' },
    { key: 'permission.revoke', scope: 'ALL' },
    { key: 'role.read', scope: 'ALL' },
    { key: 'role.change', scope: 'ALL' },
    { key: 'role.permissions.update', scope: 'ALL' },
    { key: 'announcement.read', scope: 'ALL' },
    { key: 'announcement.create', scope: 'ALL' },
    { key: 'announcement.update', scope: 'ALL' },
    { key: 'announcement.delete', scope: 'ALL' },
    { key: 'audit.read', scope: 'ALL' },
    { key: 'notification.read', scope: 'ALL' },
    { key: 'notification.resolve', scope: 'ALL' },
    { key: 'ai.chat.history.read', scope: 'ALL' },
    { key: 'ai.admin.configure', scope: 'ALL' },
    { key: 'plan.read', scope: 'ALL' },
    { key: 'plan.manage', scope: 'ALL' },
    { key: 'membership.read', scope: 'ALL' },
    { key: 'membership.sell', scope: 'ALL' },
    { key: 'membership.cancel.request', scope: 'ALL' },
    { key: 'membership.freeze', scope: 'ALL' },
    { key: 'membership.cancel', scope: 'ALL' },
    { key: 'membership.term.adjust', scope: 'ALL' },
    { key: 'membership.status.correct', scope: 'ALL' },
    { key: 'membership.import', scope: 'ALL' },
    { key: 'payment.read', scope: 'ALL' },
    { key: 'payment.record', scope: 'ALL' },
    { key: 'payment.discount.statutory', scope: 'ALL' },
    { key: 'payment.discount.grant', scope: 'ALL' },
    { key: 'payment.void', scope: 'ALL' },
    // ADMIN only, both of them. FRONT_DESK does not get amend for the same
    // reason they do not get payment.void: the desk's correction path is
    // "void it and ring it again in the open drawer", which reconciles
    // because the money is in front of them.
    { key: 'payment.amend', scope: 'ALL' },
    { key: 'payment.archive', scope: 'ALL' },
    { key: 'shift.manage', scope: 'ALL' },
    // ADMIN only: the Revenue tab of Reports and its two routes.
    { key: 'revenue.read', scope: 'ALL' },
    { key: 'job.run', scope: 'ALL' },
    // ── Coach tools (feat/coach-tools) ── complaint review only; every read
    // is audited. ADMIN does not hold chat.use: they are not a party.
    { key: 'chat.review', scope: 'ALL' },
  ],
};

/**
 * Every string in a `requires` array must name a real catalogue key.
 *
 * Without this a typo is silently ignored — the prerequisite simply never
 * applies, and the composite keys chunks 1-2 introduce (`membership.sell`,
 * `walkin.sell`) rest their entire safety argument on prerequisites being
 * enforced at grant time.
 */
export function assertRequiresKeysExist(catalogue: readonly PermissionDefinition[]): void {
  const keys = new Set(catalogue.map((def) => def.key));
  const failures: string[] = [];

  for (const def of catalogue) {
    for (const req of def.requires) {
      if (!keys.has(req)) {
        failures.push(`"${def.key}" requires "${req}", which is not a catalogue key`);
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Permission catalogue has unknown prerequisites:\n  - ${failures.join('\n  - ')}`,
    );
  }
}

/**
 * No role may hold a key without also holding everything that key requires.
 *
 * Checking only the DIRECT prerequisites of every held key is already the full
 * transitive closure, by induction: if A is held then requires(A) must be held,
 * and each of those being held forces its own requires in the same pass. A
 * separate graph walk would be the same check written twice.
 *
 * The seed is the only live grant path, so this runs there and fails loudly
 * rather than leaving a role with a half-granted composite permission.
 */
export function assertRequiresClosure(
  catalogue: readonly PermissionDefinition[],
  grants: Record<Exclude<Role, 'DEV'>, readonly PermissionGrant[]>,
): void {
  const byKey = new Map(catalogue.map((def) => [def.key, def]));
  const failures: string[] = [];

  for (const [role, roleGrants] of Object.entries(grants)) {
    const held = new Set(roleGrants.map((grant) => grant.key));
    for (const key of held) {
      const def = byKey.get(key);
      // A granted key absent from the catalogue is a different failure and is
      // already covered by the registry spec; skipping it keeps one error to
      // one cause.
      if (!def) continue;
      for (const req of def.requires) {
        if (!held.has(req)) {
          failures.push(`${role} is granted "${key}" but not its prerequisite "${req}"`);
        }
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(`Role grants violate the requires closure:\n  - ${failures.join('\n  - ')}`);
  }
}
