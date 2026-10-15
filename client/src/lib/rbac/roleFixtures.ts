import { PERMISSIONS } from '@got/shared';
import type { HeldPermission } from './permissions';

/**
 * What `GET /me` returns for each seeded role, copied from
 * `server/src/rbac/permission-registry.ts` (ROLE_PERMISSIONS). TEST DATA ONLY —
 * the app never decides anything from a role; these exist so the nav and
 * landing tests can say "a front-desk account sees exactly this".
 *
 * If the registry's grant table changes, update these to match; the nav tests
 * that read them are what tell you which screens moved.
 */
const grants = (list: ReadonlyArray<[string, 'OWN' | 'ALL']>): HeldPermission[] =>
  list.map(([key, scope]) => ({ key, scope }));

export const CLIENT_PERMISSIONS = grants([
  ['checkin.self', 'OWN'],
  ['ai.chat.use', 'OWN'],
  ['ai.chat.history.read', 'OWN'],
  ['announcement.read', 'ALL'],
  ['plan.read', 'ALL'],
  ['class.read', 'ALL'],
  ['booking.create', 'OWN'],
  ['membership.self', 'OWN'],
  ['progress.self', 'OWN'],
  ['coach.self', 'OWN'],
  // ── Coach tools (feat/coach-tools) ──
  ['chat.use', 'OWN'],
  ['workout.self', 'OWN'],
  ['workout.member', 'OWN'],
]);

export const FRONT_DESK_PERMISSIONS = grants([
  ['class.read', 'ALL'],
  ['booking.read', 'ALL'],
  ['booking.attend', 'ALL'],
  ['booking.manage', 'ALL'],
  ['checkin.self', 'OWN'],
  ['checkin.read', 'ALL'],
  ['checkin.create', 'ALL'],
  ['checkin.close', 'ALL'],
  ['walkin.sell', 'ALL'],
  ['checkin.station_token.issue', 'ALL'],
  ['member.read', 'ALL'],
  ['member.create', 'ALL'],
  ['member.update', 'ALL'],
  ['announcement.read', 'ALL'],
  ['notification.read', 'ALL'],
  ['notification.resolve', 'ALL'],
  ['plan.read', 'ALL'],
  ['membership.read', 'ALL'],
  ['membership.sell', 'ALL'],
  ['membership.cancel.request', 'ALL'],
  ['payment.read', 'ALL'],
  ['payment.record', 'ALL'],
  ['payment.discount.statutory', 'ALL'],
  ['shift.manage', 'ALL'],
]);

export const COACH_PERMISSIONS = grants([
  ['class.read', 'ALL'],
  ['booking.read', 'ALL'],
  ['booking.attend', 'ALL'],
  ['member.read', 'OWN'],
  ['coach.read', 'OWN'],
  ['progress.read', 'OWN'],
  ['progress.record', 'OWN'],
  ['checkin.self', 'OWN'],
  ['checkin.read', 'OWN'],
  ['announcement.read', 'ALL'],
  ['ai.chat.history.read', 'OWN'],
  ['plan.read', 'ALL'],
  ['membership.read', 'OWN'],
  // ── Coach tools (feat/coach-tools) ──
  ['chat.use', 'OWN'],
  ['workout.manage', 'OWN'],
  ['workout.suggest', 'OWN'],
]);

export const ADMIN_PERMISSIONS = grants([
  ['class.read', 'ALL'],
  ['class.manage', 'ALL'],
  ['booking.read', 'ALL'],
  ['booking.attend', 'ALL'],
  ['booking.manage', 'ALL'],
  ['member.read', 'ALL'],
  ['member.create', 'ALL'],
  ['member.update', 'ALL'],
  ['member.suspend', 'ALL'],
  ['member.delete', 'ALL'],
  ['checkin.self', 'OWN'],
  ['checkin.read', 'ALL'],
  ['checkin.create', 'ALL'],
  ['checkin.close', 'ALL'],
  ['checkin.void', 'ALL'],
  ['checkin.override', 'ALL'],
  ['walkin.sell', 'ALL'],
  ['checkin.station_token.issue', 'ALL'],
  ['station.manage', 'ALL'],
  ['coach.read', 'ALL'],
  ['coach.assign', 'ALL'],
  ['coach.update', 'ALL'],
  // ── Staff & Access ──
  ['coach.profile.update', 'ALL'],
  ['staff.invite', 'ALL'],
  // ── end Staff & Access ──
  ['permission.read', 'ALL'],
  ['permission.grant', 'ALL'],
  ['permission.revoke', 'ALL'],
  ['role.read', 'ALL'],
  ['role.change', 'ALL'],
  ['role.permissions.update', 'ALL'],
  ['announcement.read', 'ALL'],
  ['announcement.create', 'ALL'],
  ['announcement.update', 'ALL'],
  ['announcement.delete', 'ALL'],
  ['audit.read', 'ALL'],
  ['notification.read', 'ALL'],
  ['notification.resolve', 'ALL'],
  ['ai.chat.history.read', 'ALL'],
  ['ai.admin.configure', 'ALL'],
  ['plan.read', 'ALL'],
  ['plan.manage', 'ALL'],
  ['membership.read', 'ALL'],
  ['membership.sell', 'ALL'],
  ['membership.cancel.request', 'ALL'],
  ['membership.freeze', 'ALL'],
  ['membership.cancel', 'ALL'],
  ['membership.term.adjust', 'ALL'],
  ['membership.status.correct', 'ALL'],
  ['membership.import', 'ALL'],
  ['payment.read', 'ALL'],
  ['payment.record', 'ALL'],
  ['payment.discount.statutory', 'ALL'],
  ['payment.discount.grant', 'ALL'],
  ['payment.void', 'ALL'],
  ['payment.amend', 'ALL'],
  ['payment.archive', 'ALL'],
  ['shift.manage', 'ALL'],
  ['revenue.read', 'ALL'],
  ['job.run', 'ALL'],
  // ── Coach tools (feat/coach-tools) ──
  ['chat.review', 'ALL'],
]);

/** DEV — the Super Admin — bypasses the table and resolves every key at ALL. */
export const DEV_PERMISSIONS: HeldPermission[] = Object.values(PERMISSIONS).map((key) => ({
  key,
  scope: 'ALL',
}));
