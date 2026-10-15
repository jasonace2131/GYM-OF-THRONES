import type {
  ActiveCheckIn,
  CheckInRecord,
  DeskArrival,
  DeskDenial,
  DeskMember,
  DeskStationStatus,
} from '@got/shared';
import type {
  Membership,
  MembershipHold,
  UserStatus,
  AccessVerdict as PrismaAccessVerdict,
  CheckInMethod as PrismaCheckInMethod,
  DenialReason as PrismaDenialReason,
} from '@prisma/client';
import type { CivilDate } from '../common/time/gym-time';
import {
  accessVerdict,
  type AccessResult,
  type AccessVerdictConfig,
  type MembershipSnapshot,
} from '../membership/access-verdict';
import { toMembershipSnapshot } from '../membership/membership.presenter';

/**
 * The desk console's projections. PURE — no clock, no Prisma client, no config
 * service; `now` arrives as a parameter wherever a duration is computed.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * `DeskMember` IS A PRIVACY BOUNDARY, NOT A CONVENIENCE TYPE.
 *
 * This projection streams continuously to a PC in a public lobby and stays on
 * screen all day. Every field added here is a field a stranger can read over
 * the counter while the operator is in the back room, so the test for a new
 * one is not "would the desk find this useful" — almost anything would — but
 * "is it worth someone else reading". Phone, email, address, payment history
 * and body metrics are all deliberately absent and should stay that way.
 *
 * `avatarUrl` is the exception that earns its place: the photo's highest-value
 * use in the whole system is recognising the person who just got bounced, in a
 * room of thirty, before they leave.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** The minimum a caller must have read to build a `DeskMember`. */
export interface DeskMemberSource {
  id: string;
  firstName: string;
  lastName: string;
  memberCode: string | null;
  avatarUrl: string | null;
}

export function toDeskMember(
  user: DeskMemberSource,
  membership: MembershipSnapshot | null,
  verdict: AccessResult | null,
): DeskMember {
  return {
    userId: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    memberCode: user.memberCode,
    avatarUrl: user.avatarUrl,
    planName: membership?.planName ?? null,
    status: membership?.status ?? null,
    endsOn: membership?.endsOn ?? null,
    daysRemaining: verdict?.daysRemaining ?? null,
  };
}

/** The columns `toActiveCheckIn` and `toDeskArrival` need off a `CheckIn` row. */
export interface DeskCheckInSource {
  id: string;
  occurredAt: Date;
  endedAt: Date | null;
  verdict: PrismaAccessVerdict;
  method: PrismaCheckInMethod;
  offSiteOrigin: boolean;
  photoOnFileAtTime: boolean;
  station: { code: string; name: string } | null;
}

export function toActiveCheckIn(
  row: DeskCheckInSource,
  member: DeskMember,
  now: Date,
): ActiveCheckIn {
  return {
    checkInId: row.id,
    member,
    occurredAt: row.occurredAt.toISOString(),
    // Rounded, not truncated: a rail that reads "0 m" for fifty seconds makes
    // staff think the board is stuck.
    durationMinutes: Math.max(0, Math.round((now.getTime() - row.occurredAt.getTime()) / 60_000)),
    verdict: row.verdict as unknown as ActiveCheckIn['verdict'],
    method: row.method as unknown as ActiveCheckIn['method'],
    station: row.station,
    offSiteOrigin: row.offSiteOrigin,
    photoOnFileAtTime: row.photoOnFileAtTime,
  };
}

/**
 * One line on the ARRIVALS rail.
 *
 * A row with `endedAt` set is rendered as the CHECK_OUT it is, at the instant
 * it closed. Showing a departed member as an arrival is how a "who is in the
 * building" board loses the trust that makes it worth having.
 */
export function toDeskArrival(row: DeskCheckInSource, member: DeskMember): DeskArrival {
  const closed = row.endedAt !== null;
  return {
    kind: closed ? 'CHECK_OUT' : 'CHECK_IN',
    checkInId: row.id,
    member,
    at: (closed ? row.endedAt! : row.occurredAt).toISOString(),
    verdict: row.verdict as unknown as DeskArrival['verdict'],
    method: row.method as unknown as DeskArrival['method'],
    station: row.station,
    offSiteOrigin: row.offSiteOrigin,
  };
}

export interface DeskDenialSource {
  id: string;
  occurredAt: Date;
  reason: PrismaDenialReason;
  outcome: string;
  tokenStalenessSeconds: number | null;
  offSiteOrigin: boolean;
  station: { code: string; name: string } | null;
}

/**
 * `staffMessage` comes from a verdict run against the member's CURRENT
 * membership, never replayed from the moment of denial.
 *
 * By the time a staffer reads this card the useful question is "what do I sell
 * them right now", not "what was true ninety seconds ago" — and a renewal rung
 * up in between should make the card say so rather than keep telling staff to
 * collect money that is already in the drawer.
 */
export function toDeskDenial(
  row: DeskDenialSource,
  member: DeskMember,
  staffMessage: string,
): DeskDenial {
  return {
    denialId: row.id,
    member,
    at: row.occurredAt.toISOString(),
    reason: row.reason as unknown as DeskDenial['reason'],
    staffMessage,
    outcome: row.outcome as DeskDenial['outcome'],
    tokenStalenessSeconds: row.tokenStalenessSeconds,
    offSiteOrigin: row.offSiteOrigin,
    station: row.station,
  };
}

export interface DeskStationSource {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  lastTokenIssuedAt: Date | null;
}

/**
 * `live` is derived from a column the display already writes on every
 * successful mint, which is why there is no `POST /front-desk/station/heartbeat`
 * for anyone to forget to call — and no second definition of "the tablet is
 * awake" to disagree with this one.
 *
 * Two batch windows of slack, not one: a display polling once per batch that
 * misses a single request is a flaky network, not a dark screen, and a tile
 * that flickers DARK on every dropped packet is a tile staff learns to ignore.
 */
export function toDeskStationStatus(
  row: DeskStationSource,
  now: Date,
  batchWindowSeconds: number,
): DeskStationStatus {
  const staleAfterMs = 2 * batchWindowSeconds * 1000;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isActive: row.isActive,
    lastTokenIssuedAt: row.lastTokenIssuedAt?.toISOString() ?? null,
    live:
      row.isActive &&
      row.lastTokenIssuedAt !== null &&
      now.getTime() - row.lastTokenIssuedAt.getTime() <= staleAfterMs,
  };
}

/**
 * THE DENIAL FUNNEL IS A QUERY, NOT A COLUMN.
 *
 * `GYM_CLOSED`, `CHECKIN_DAILY_LIMIT` and `STATION_TOKEN_EXPIRED` would
 * otherwise sit in `UNRESOLVED` forever and poison the conversion rate — no
 * staffer can "resolve" a member who scanned a stale code. Filtering to the
 * reasons the desk can actually sell against is one WHERE clause and no enum
 * change.
 */
export const SELLABLE_DENIAL_REASONS = [
  'NO_MEMBERSHIP',
  'MEMBERSHIP_EXPIRED',
  'MEMBERSHIP_FROZEN',
  'MEMBERSHIP_CANCELLED',
] as const;

/** '2026-08-20T10:14:00.000Z' as an opaque cursor. */
export function cursorFrom(instants: readonly Date[], fallback: Date): string {
  const latest = instants.reduce(
    (max, at) => (at.getTime() > max.getTime() ? at : max),
    new Date(0),
  );
  return (latest.getTime() === 0 ? fallback : latest).toISOString();
}

/**
 * The board's row for an off-the-street walk-in guest.
 *
 * They have no account, no member code, no plan and no photo — and `guestPhone`
 * is deliberately not read here even though the sale collected it. What the
 * desk needs on a lobby screen is a name to call out; a phone number on that
 * screen is exactly what `DeskMember` exists to prevent.
 */
export function toDeskGuest(guestName: string | null): DeskMember {
  // `''.split(/\s+/)` is `['']`, not `[]` — so a whitespace-only name has to be
  // normalised BEFORE the split, or the board renders a nameless row.
  const trimmed = (guestName ?? '').trim();
  const parts = (trimmed.length === 0 ? 'Walk-in guest' : trimmed).split(/\s+/);
  return {
    userId: null,
    firstName: parts[0] ?? 'Walk-in',
    lastName: parts.slice(1).join(' '),
    memberCode: null,
    avatarUrl: null,
    planName: null,
    status: null,
    endsOn: null,
    daysRemaining: null,
  };
}

/** Everything `toCheckInRecord` reads off a `CheckIn` and its member. */
export interface CheckInRecordSource {
  id: string;
  entryType: string;
  verdict: PrismaAccessVerdict;
  method: PrismaCheckInMethod;
  occurredAt: Date;
  endedAt: Date | null;
  closeMethod: string | null;
  autoClosed: boolean;
  reopenCount: number;
  voidedAt: Date | null;
  voidReason: string | null;
  guestName: string | null;
  // The funding Payment's id. CheckInRecord CONTAINS a DeskMember but is not
  // the lobby projection (the display feed uses DeskArrival); the value is an
  // opaque uuid carrying no money, and the only holder of checkin.read
  // without payment.read is COACH — who can fetch nothing with it. It earns
  // its place because POST /front-desk/walk-ins returns a CheckInRecord and,
  // without it, the console has nothing to print after ringing a sale and no
  // userId to re-query with for an account-less guest.
  paymentId: string | null;
  station: { code: string; name: string } | null;
  user: (DeskMemberSource & { status: string; membership: MembershipRowLike | null }) | null;
}

interface MembershipRowLike {
  holds: unknown[];
}

/**
 * One recorded visit, for the two routes that act on a visit that already
 * exists rather than creating one.
 *
 * `durationMinutes` is NULL while the visit is open rather than "minutes so
 * far": a duration on an open visit is a number that changes every time it is
 * read, and a rail that renders it as a fact teaches staff to trust a moving
 * target. The live board computes elapsed time itself, from `occurredAt`.
 */
export function toCheckInRecord(
  row: CheckInRecordSource,
  today: CivilDate,
  cfg: AccessVerdictConfig,
): CheckInRecord {
  const member =
    row.user === null ? toDeskGuest(row.guestName) : deskMemberFrom(row.user as never, today, cfg);

  return {
    checkInId: row.id,
    member,
    entryType: row.entryType as CheckInRecord['entryType'],
    verdict: row.verdict as unknown as CheckInRecord['verdict'],
    method: row.method as unknown as CheckInRecord['method'],
    occurredAt: row.occurredAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    durationMinutes:
      row.endedAt === null
        ? null
        : Math.max(0, Math.round((row.endedAt.getTime() - row.occurredAt.getTime()) / 60_000)),
    closeMethod: row.closeMethod as CheckInRecord['closeMethod'],
    autoClosed: row.autoClosed,
    reopenCount: row.reopenCount,
    station: row.station,
    paymentId: row.paymentId,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    voidReason: row.voidReason,
  };
}

/**
 * The member projection, built from a row that already carries its membership
 * and running hold. Shared with `FrontDeskService` rather than duplicated —
 * `DeskMember` is a privacy boundary, and two builders is two places for a
 * field to creep in.
 */
/**
 * Exported for the attendance report (routes 53-55), which projects the same
 * rows and must go through the same privacy boundary. A second copy of this
 * would be a second answer to "what may a staff screen show about a member".
 */
export function deskMemberFrom(
  user: DeskMemberSource & {
    status: UserStatus;
    membership: (Membership & { holds: MembershipHold[] }) | null;
  },
  today: CivilDate,
  cfg: AccessVerdictConfig,
): DeskMember {
  const snapshot =
    user.membership === null
      ? null
      : toMembershipSnapshot(user.membership, user.membership.holds[0] ?? null);

  const verdict = accessVerdict(
    { userStatus: user.status, membership: snapshot, dayPassValidToday: false },
    today,
    cfg,
  );

  return toDeskMember(user, snapshot, verdict);
}
