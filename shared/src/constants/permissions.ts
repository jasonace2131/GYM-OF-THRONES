/**
 * Every permission key in the catalogue, as a typed constant.
 *
 * The CATALOGUE itself lives in `server/src/rbac/permission-registry.ts` — that
 * is what the seed reads and what the database holds. This is the client's
 * copy, so a screen gates on `PERMISSIONS.MEMBER_READ` rather than on a string
 * literal a typo can silently turn into "nobody holds this".
 *
 * `server/src/rbac/permission-constants.spec.ts` compares the two in both
 * directions, so adding a key to one and not the other fails the server's unit
 * tests. Naming is mechanical: upper-case the key and turn every dot into an
 * underscore (`checkin.station_token.issue` → CHECKIN_STATION_TOKEN_ISSUE).
 */
export const PERMISSIONS = {
  MEMBER_READ: 'member.read',
  MEMBER_CREATE: 'member.create',
  MEMBER_UPDATE: 'member.update',
  MEMBER_SUSPEND: 'member.suspend',
  MEMBER_DELETE: 'member.delete',
  PLAN_READ: 'plan.read',
  PLAN_MANAGE: 'plan.manage',
  MEMBERSHIP_READ: 'membership.read',
  MEMBERSHIP_SELL: 'membership.sell',
  MEMBERSHIP_CANCEL_REQUEST: 'membership.cancel.request',
  MEMBERSHIP_FREEZE: 'membership.freeze',
  MEMBERSHIP_CANCEL: 'membership.cancel',
  MEMBERSHIP_TERM_ADJUST: 'membership.term.adjust',
  MEMBERSHIP_STATUS_CORRECT: 'membership.status.correct',
  MEMBERSHIP_IMPORT: 'membership.import',
  PAYMENT_READ: 'payment.read',
  PAYMENT_RECORD: 'payment.record',
  PAYMENT_DISCOUNT_STATUTORY: 'payment.discount.statutory',
  PAYMENT_DISCOUNT_GRANT: 'payment.discount.grant',
  PAYMENT_VOID: 'payment.void',
  PAYMENT_AMEND: 'payment.amend',
  PAYMENT_ARCHIVE: 'payment.archive',
  SHIFT_MANAGE: 'shift.manage',
  REVENUE_READ: 'revenue.read',
  JOB_RUN: 'job.run',
  CHECKIN_SELF: 'checkin.self',
  CHECKIN_READ: 'checkin.read',
  CHECKIN_CREATE: 'checkin.create',
  CHECKIN_CLOSE: 'checkin.close',
  CHECKIN_VOID: 'checkin.void',
  CHECKIN_OVERRIDE: 'checkin.override',
  WALKIN_SELL: 'walkin.sell',
  CHECKIN_STATION_TOKEN_ISSUE: 'checkin.station_token.issue',
  STATION_MANAGE: 'station.manage',
  COACH_READ: 'coach.read',
  COACH_ASSIGN: 'coach.assign',
  COACH_UPDATE: 'coach.update',
  // ── Staff & Access ──
  COACH_PROFILE_UPDATE: 'coach.profile.update',
  STAFF_INVITE: 'staff.invite',
  // ── end Staff & Access ──
  PROGRESS_READ: 'progress.read',
  PROGRESS_RECORD: 'progress.record',
  PERMISSION_READ: 'permission.read',
  PERMISSION_GRANT: 'permission.grant',
  PERMISSION_REVOKE: 'permission.revoke',
  ROLE_READ: 'role.read',
  ROLE_CHANGE: 'role.change',
  ROLE_PERMISSIONS_UPDATE: 'role.permissions.update',
  ANNOUNCEMENT_READ: 'announcement.read',
  ANNOUNCEMENT_CREATE: 'announcement.create',
  ANNOUNCEMENT_UPDATE: 'announcement.update',
  ANNOUNCEMENT_DELETE: 'announcement.delete',
  CLASS_READ: 'class.read',
  CLASS_MANAGE: 'class.manage',
  BOOKING_CREATE: 'booking.create',
  BOOKING_READ: 'booking.read',
  BOOKING_ATTEND: 'booking.attend',
  // The desk adding a member to a class, or taking one out (2026-10-11).
  BOOKING_MANAGE: 'booking.manage',
  AUDIT_READ: 'audit.read',
  NOTIFICATION_READ: 'notification.read',
  NOTIFICATION_RESOLVE: 'notification.resolve',
  AI_CHAT_USE: 'ai.chat.use',
  AI_CHAT_HISTORY_READ: 'ai.chat.history.read',
  AI_ADMIN_CONFIGURE: 'ai.admin.configure',
  MEMBERSHIP_SELF: 'membership.self',
  PROGRESS_SELF: 'progress.self',
  COACH_SELF: 'coach.self',

  // ── Coach tools (feat/coach-tools): chat and workout plans ──
  CHAT_USE: 'chat.use',
  CHAT_REVIEW: 'chat.review',
  WORKOUT_SUGGEST: 'workout.suggest',
  WORKOUT_MANAGE: 'workout.manage',
  WORKOUT_SELF: 'workout.self',

  // ── Member workout planner (feat/member-workouts) ──
  WORKOUT_MEMBER: 'workout.member',
} as const;

/** One catalogue key. */
export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

/**
 * How far a grant reaches: `OWN` is the caller's own rows (or, for a coach,
 * the members assigned to them); `ALL` is everybody's.
 */
export type PermissionGrantScope = 'OWN' | 'ALL';

const KEYS: ReadonlySet<string> = new Set(Object.values(PERMISSIONS));

/** Whether a string is a catalogue key — for narrowing data that came off the wire. */
export function isPermissionKey(value: string): value is PermissionKey {
  return KEYS.has(value);
}
