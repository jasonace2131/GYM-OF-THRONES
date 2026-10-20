import type { MembershipStatus } from './membership.types';
import type { CivilDate } from './time.types';

// Enums and unions the member's phone and the desk feed both switch on.
//
// §6.0.2 is the normative surface for this file. Where §5.2 lists a shorter
// DenialReason, §6.0.2 wins: mirroring the short list into Prisma first and
// widening it later is the enum-removal migration shape that takes hand-written
// CHECK constraints with it, invisibly.

/**
 * Three values, no more. There is no SELF_QR (every self check-in is a station
 * scan), no SELF_QUEUED (there is no offline queue at any TTL) and no
 * SELF_KIOSK in v1.
 */
export enum CheckInMethod {
  STATION_QR = 'STATION_QR',
  MEMBER_CODE = 'MEMBER_CODE',
  MANUAL = 'MANUAL',
}

/** Why the door said no. Rendered on the member's own handset and on the desk feed. */
export enum DenialReason {
  NO_MEMBERSHIP = 'NO_MEMBERSHIP',
  MEMBERSHIP_EXPIRED = 'MEMBERSHIP_EXPIRED',
  MEMBERSHIP_FROZEN = 'MEMBERSHIP_FROZEN',
  MEMBERSHIP_CANCELLED = 'MEMBERSHIP_CANCELLED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  ACCOUNT_DEACTIVATED = 'ACCOUNT_DEACTIVATED',
  STATION_TOKEN_EXPIRED = 'STATION_TOKEN_EXPIRED',
  ALREADY_CHECKED_IN = 'ALREADY_CHECKED_IN',
  CHECKIN_DAILY_LIMIT = 'CHECKIN_DAILY_LIMIT',
  GYM_CLOSED = 'GYM_CLOSED',
}

/**
 * Three-valued on purpose. Any caller that collapses this to a boolean is
 * rejected in review: the door opens for both ALLOW and GRACE, but GRACE must
 * render an amber banner and fire the collection prompt.
 */
export type AccessDecision = 'ALLOW' | 'GRACE' | 'DENY';

/** Why the door said yes. Paired with AccessDecision, never inferred from it. */
export type AllowReason =
  | 'MEMBERSHIP_ACTIVE'
  | 'MEMBERSHIP_EXPIRES_TODAY'
  | 'MEMBERSHIP_EXPIRING_SOON'
  | 'MEMBERSHIP_ENDING'
  | 'MEMBERSHIP_IN_GRACE'
  | 'DAY_PASS_VALID';

/** The full reason surface of a verdict, allow or deny. */
export type AccessReason = AllowReason | DenialReason;

/**
 * The stored verdict on an admitted entry. Only ever an allow — refusals carry
 * a DenialReason instead.
 *
 * Exactly two values. `decision === 'GRACE'` maps to ALLOWED_IN_GRACE and
 * `'ALLOW'` to ALLOWED; there is deliberately no ALLOWED_OVERRIDE, because an
 * override writes CheckInDenial.outcome = OVERRIDDEN and no CheckIn verdict.
 */
export enum AccessVerdict {
  ALLOWED = 'ALLOWED',
  ALLOWED_IN_GRACE = 'ALLOWED_IN_GRACE',
}

/**
 * `GET /checkin/station-tokens`. The display holds no secret and mints
 * nothing — every token in `tokens` arrives already signed (§6.2.1).
 */
export interface StationTokenBatch {
  station: { id: string; code: string; name: string };
  /** `STATION_TOKEN_SLOT_SECONDS`. */
  slotSeconds: number;
  /**
   * The offset anchor. The display computes `serverTime − Date.now()` once
   * per fetch and re-anchors every batch, so its own clock never matters.
   */
  serverTime: string;
  /**
   * Per-station key version. The display compares it on each refill and
   * discards its cache on a change, so a `tokenEpoch` bump takes effect
   * within one poll rather than within one batch.
   */
  tokenEpoch: number;
  /**
   * Gym-hours edge in gym time. When `now > openUntil` the display renders
   * CLOSED rather than a code the POST would refuse anyway.
   */
  openUntil: string;
  /**
   * Opaque cache-validity handle for `GET .../station-tokens/head`'s
   * `If-None-Match`. Carries the station code and `tokenEpoch` this batch was
   * minted under.
   */
  batchEtag: string;
  tokens: Array<{
    slot: number;
    /**
     * The end of THIS slot, never the end of the server's look-back window.
     * The tolerance belongs to the verifier; a renderer that consumed it
     * would spend the whole skew budget before the packet leaves the phone.
     */
    notBefore: string;
    notAfter: string;
    /** `GOTS1.9F2K.59570000.4RTXK8B2QWY5H3PZ` */
    payload: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/checkin — the write path's response contract (§6.5.3, §7.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Six values, not five. §7.4's list omits `REOPENED`; §6.6.4 defines it, the
 * `StationScanOutcome` Prisma enum carries it, and `CheckIn.reopenCount` exists
 * to record it — so the shorter list is the stale one and this is the settled
 * shape.
 */
export type CheckInOutcome =
  'CHECKED_IN' | 'RECHECKED_IN' | 'REOPENED' | 'CHECKED_OUT' | 'ALREADY_INSIDE' | 'DENIED';

/**
 * FOUR tones, and every surface maps tone → colour + word + glyph with NO
 * branching on `denial.reason`. A client that switched on DenialReason for
 * colour renders a blank card the first time the enum gains a value.
 *
 * `GOODBYE` is never green: a check-out must not read as an admission.
 * `SEE_DESK` is never full-bleed and never red (§9.5) — a phone showing a red
 * field is legible across a lobby, and the member is standing in a queue.
 */
export type CheckInTone = 'WELCOME' | 'GRACE' | 'GOODBYE' | 'SEE_DESK';

export interface CheckInDisplay {
  tone: CheckInTone;
  /** Display size, ≤ 24 characters — one fixation. */
  headline: string;
  /** Body size, never larger. */
  subhead: string;
  /**
   * Body size, NEVER larger. The server decides what the queue behind the
   * member is allowed to read; a client rendering this at display size is a
   * review rejection, not a copy note.
   */
  detail: string | null;
}

/**
 * Informational only. Owner decision 9 forbids the portal POSTing a purchase,
 * so this never carries a price the member can pay in-app — it routes to the
 * desk.
 */
export interface CheckInNextStep {
  kind: 'NONE' | 'SEE_DESK' | 'RENEW_AT_DESK' | 'WALK_IN_AT_DESK';
  label: string;
}

/**
 * Just enough membership for the portal to refresh without a second call.
 * Deliberately NOT the CRM's MembershipDetail: this body is rendered on a
 * handset in public, and every field here is one the member already knows.
 */
export interface CheckInMembershipSummary {
  planName: string | null;
  status: MembershipStatus | null;
  endsOn: CivilDate | null;
  daysRemaining: number | null;
  decision: AccessDecision;
}

/**
 * One shape for every way a check-in can be recorded — the write path is
 * direction-agnostic and so is its result.
 *
 * THE REPLAY IS A STORED SNAPSHOT, NOT A RECOMPUTATION. `StationScan` carries
 * `responseSnapshot`, written in the same transaction as the outcome, and the
 * replay path returns it verbatim with `replayed: true` overlaid. Without it
 * "the second request returns an identical body" is not keepable:
 * `ALREADY_INSIDE` writes neither a `CheckIn` nor a `CheckInDenial`, so there
 * is nothing to rebuild from, and `membership` and `visitNumberThisMonth`
 * legitimately change between two presentations of one code.
 */
export interface CheckInResult {
  outcome: CheckInOutcome;
  replayed: boolean;
  display: CheckInDisplay;

  checkIn: {
    id: string;
    occurredAt: string;
    businessDate: CivilDate;
    verdict: AccessVerdict;
    visitNumberThisMonth: number;
  } | null;

  /** `CHECKED_OUT` only. */
  session: { startedAt: string; endedAt: string; durationMinutes: number } | null;

  /**
   * `DENIED` only. `memberMessage` has §9.5's dignity mapping applied
   * SERVER-SIDE; ACCOUNT_SUSPENDED never renders its real reason on a phone in
   * a queue. The staff-directive form of the same denial travels to the desk
   * on the feed, in a different HTTP response — so this body structurally
   * cannot leak it.
   */
  denial: { id: string; reason: DenialReason; memberMessage: string } | null;

  /**
   * True only on `ALREADY_INSIDE` from the member's OWN scan of a still-current
   * station code: the phone shows Check out / Stay checked in, and that scan
   * is proof of presence for `POST /checkin/checkout` for two minutes. False
   * on a desk entry and on an expired code. The client reads this flag rather
   * than inferring it from outcome or station.
   */
  checkOutOffered: boolean;

  nextStep: CheckInNextStep | null;
  membership: CheckInMembershipSummary;
  /** Null on MANUAL / MEMBER_CODE, which carry no station. */
  station: { code: string; name: string } | null;
  serverTime: string;
}

/**
 * `GET /me/check-in-status` — the cached read on the way INTO the scanner.
 *
 * It is what renders "You're checked in since 6:12 PM — scan again when you
 * leave to check out" before the camera arms. A second scan never closes the
 * visit by itself: it offers a Check out button, and the member confirms
 * through `POST /checkin/checkout` (owner, 2026-10-20).
 */
export interface CheckInStatus {
  open: { checkInId: string; startedAt: string } | null;
  membership: CheckInMembershipSummary;
  /** Whether `accessVerdict` would admit them right now. */
  wouldAdmit: boolean;
  visitsToday: number;
  serverTime: string;
}

/**
 * Reason → member copy (§9.5), exported from here and consumed by both the
 * portal and the console so the two surfaces cannot contradict each other in
 * front of the same person.
 *
 * These are TEMPLATES, not final strings: the server substitutes the date and
 * the plan price before the body leaves. `ACCOUNT_SUSPENDED` and
 * `ACCOUNT_DEACTIVATED` are intentionally vague and take no substitution —
 * why an account was suspended is between the member and management, and
 * rendering "SUSPENDED — NON-PAYMENT" on a phone in a queue is precisely the
 * humiliation §9.5 exists to prevent. Staff has the real reason on the
 * terminal, two feet away, which is the correct channel.
 */
export const DENIAL_MEMBER_COPY: Readonly<Record<DenialReason, string>> = {
  NO_MEMBERSHIP: 'No plan on file yet. The desk can set you up, or sell you today.',
  MEMBERSHIP_EXPIRED: 'Your plan has ended. The desk can renew you, or sell you today.',
  MEMBERSHIP_FROZEN: 'Your plan is paused. The desk can unpause it, or sell you today.',
  MEMBERSHIP_CANCELLED: 'Your plan has ended. The desk can start a new one.',
  ACCOUNT_SUSPENDED: "There's a note on your account. Please talk to the desk.",
  ACCOUNT_DEACTIVATED: "There's a note on your account. Please talk to the desk.",
  STATION_TOKEN_EXPIRED: 'That code had just changed. Scan the new one on the screen.',
  ALREADY_CHECKED_IN: "You're already checked in.",
  CHECKIN_DAILY_LIMIT: "That's already a few visits today. The desk can check you in.",
  GYM_CLOSED: "We're not open yet. The desk can check you in if you're already inside.",
};

/**
 * What `DeskFeed.publish` emits after commit, and what
 * `GET /front-desk/stream` projects (§6.9).
 *
 * It carries the STAFF-DIRECTIVE message that never travelled to the member's
 * phone. Two audiences, two transports, two different HTTP responses — which
 * is what makes the split structural rather than a convention.
 */
export interface DeskFeedEvent {
  kind: 'CHECK_IN' | 'DENIAL' | 'CHECK_OUT';
  at: string;
  /**
   * The full desk projection, composed at PUBLISH time from data the write
   * path already had in hand. Enriching per SUBSCRIBER instead would put a
   * database read on the feed's hot path and multiply it by the number of
   * open consoles — for fields the writer had loaded a millisecond earlier.
   */
  member: DeskMember;
  /** The staff-directive form — "STOP — expired 11 days. Do not admit." */
  staffMessage: string;
  outcome: CheckInOutcome;
  checkInId: string | null;
  denialId: string | null;
  reason: DenialReason | null;
  verdict: AccessVerdict | null;
  station: { id: string; code: string; name: string } | null;
  /** The quiet relay chip (§6.11.2). Denies nobody. */
  offSiteOrigin: boolean;
  photoOnFileAtTime: boolean;
}

/**
 * The date-aware form. `shortDate` is an already-formatted gym-local day
 * ('16 Aug'), never a raw ISO string and never a `Date` — a `@db.Date` read
 * back through the wrong accessor is the exact UTC+8 bug this codebase brands
 * `CivilDate` to prevent.
 *
 * The two account reasons take NO substitution and cannot be made to: their
 * branch ignores the parameter entirely. That is deliberate and structural —
 * a date is a detail, and §9.5 allows the member's phone exactly none of them
 * for an account note.
 *
 * NO PESO FIGURE APPEARS HERE, or anywhere in a response body. §5.4 is final
 * on that: prices are integer centavos on the wire and every surface renders
 * its own currency. A "₱800" baked into a server string is a price that goes
 * stale the day the owner changes it and ships in the next release instead of
 * the next request.
 */
export function denialMemberCopy(reason: DenialReason, shortDate: string | null): string {
  switch (reason) {
    case DenialReason.MEMBERSHIP_EXPIRED:
      return shortDate === null
        ? DENIAL_MEMBER_COPY[reason]
        : `Your plan ended ${shortDate}. The desk can renew you, or sell you today.`;
    case DenialReason.MEMBERSHIP_CANCELLED:
      return shortDate === null
        ? DENIAL_MEMBER_COPY[reason]
        : `Your plan ended ${shortDate}. The desk can start a new one.`;
    case DenialReason.MEMBERSHIP_FROZEN:
      return shortDate === null
        ? DENIAL_MEMBER_COPY[reason]
        : `Your plan is paused until ${shortDate}. The desk can unpause it, or sell you today.`;
    // ACCOUNT_SUSPENDED, ACCOUNT_DEACTIVATED and every non-membership reason
    // fall here on purpose: vague, and never enriched.
    default:
      return DENIAL_MEMBER_COPY[reason];
  }
}

/**
 * Why a member cannot book a class, in their own words — one copy for the
 * server's refusal (BOOKING_PLAN_REQUIRED) and the timetable's banner
 * (`MyBookingWindowWire.message`), so the two never contradict each other.
 *
 * NOT `denialMemberCopy`. That one is the door's, past tense and about today
 * ("…or sell you today"); a booking is about a class on a later day, and the
 * member is on their phone, not at the counter. The DenialReason values are
 * shared; the sentences are not.
 *
 * `shortDate` is an already-formatted gym-local day ('16 Aug'), as above:
 *   - MEMBERSHIP_EXPIRED / MEMBERSHIP_CANCELLED — the last day the plan covers.
 *     Pass it only while that day is today or later ("ends 16 Aug, before this
 *     class"); a plan that has already ended takes null and reads "has ended".
 *   - MEMBERSHIP_FROZEN — the day the pause ends.
 *
 * The dated FROZEN sentence never says "this class", because it is the only
 * dated sentence the timetable's banner can show, and a banner has no class to
 * point at. Judged on today, a pause running now ends today or later, so it
 * keeps its date; an expired or cancelled plan's last day is already behind
 * today, so the banner always gets the undated "has ended" sentence.
 *
 * Nor does it say the plan IS paused. A booking is refused for a class day
 * inside a freeze that is booked but has not begun — today the plan is
 * running, and "Your plan is paused until 26 Aug" would be false on the
 * member's own screen. "During your plan's pause, which ends 26 Aug" is true
 * of a pause running now and of one still to come.
 *
 * The account reasons stay vague and ignore the date, for the same §9.5 reason
 * as the door: why an account has a note is between the member and
 * management. No peso figure, ever.
 */
export function bookingRefusalCopy(reason: DenialReason, shortDate: string | null): string {
  switch (reason) {
    case DenialReason.NO_MEMBERSHIP:
      return 'You need a plan to book classes. Choose one on your Subscription page or at the desk.';
    case DenialReason.MEMBERSHIP_EXPIRED:
      return shortDate === null
        ? 'Your plan has ended. Renew to book classes.'
        : `Your plan ends ${shortDate}, before this class. Renew to book it.`;
    case DenialReason.MEMBERSHIP_CANCELLED:
      return shortDate === null
        ? 'Your plan has ended. Start a new plan to book classes.'
        : `Your plan ends ${shortDate}, before this class. Start a new plan to book it.`;
    case DenialReason.MEMBERSHIP_FROZEN:
      return shortDate === null
        ? "Your plan is paused, so classes can't be booked."
        : `Classes can't be booked during your plan's pause, which ends ${shortDate}.`;
    case DenialReason.ACCOUNT_SUSPENDED:
    case DenialReason.ACCOUNT_DEACTIVATED:
      return "There's a note on your account. Please talk to the desk.";
    // The door-only reasons (a stale code, already inside, the daily limit,
    // closed) never refuse a booking. Should one ever arrive, the door's copy
    // is still honest, and better than an empty toast.
    default:
      return DENIAL_MEMBER_COPY[reason];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The front-desk console — §8.4, §8.5
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE ONLY MEMBER PROJECTION THAT LEAVES THE SERVER ON THE DESK FEED, and it
 * must not widen.
 *
 * This streams continuously to a PC in a public lobby. Every field added here
 * is a field that leaks the moment that PC is left unlocked, so the test for a
 * new one is not "would the desk find it useful" but "is it worth a stranger
 * reading it over the counter". Phone numbers, emails, addresses, payment
 * history and body metrics are all deliberately absent.
 *
 * `avatarUrl` earns its place because the photo's highest-value use is exactly
 * here: recognising the person who just got bounced, in a room of thirty,
 * before they leave.
 */
export interface DeskMember {
  /**
   * NULL for an off-the-street walk-in guest, who has no account BY DESIGN —
   * a walk-in is a sale plus an entry, not a signup. The desk still needs a
   * name on the board for them, so this type describes "the person at the
   * door" rather than "a user row".
   *
   * `guestPhone` is deliberately NOT here even though the walk-in flow
   * collects it: a phone number on a lobby screen is exactly the kind of field
   * this projection exists to keep off one.
   */
  userId: string | null;
  firstName: string;
  lastName: string;
  memberCode: string | null;
  avatarUrl: string | null;
  planName: string | null;
  status: MembershipStatus | null;
  endsOn: CivilDate | null;
  daysRemaining: number | null;
}

/** A row on the "who is in the building" board. */
export interface ActiveCheckIn {
  checkInId: string;
  member: DeskMember;
  occurredAt: string;
  durationMinutes: number;
  verdict: AccessVerdict;
  method: CheckInMethod;
  station: { code: string; name: string } | null;
  /** The quiet relay chip. Denies nobody, and never has. */
  offSiteOrigin: boolean;
  /** Whether an identity check WOULD have been possible — never that one happened. */
  photoOnFileAtTime: boolean;
}

/** One line on the ARRIVALS rail. */
export interface DeskArrival {
  kind: 'CHECK_IN' | 'CHECK_OUT';
  checkInId: string;
  member: DeskMember;
  at: string;
  verdict: AccessVerdict;
  method: CheckInMethod;
  station: { code: string; name: string } | null;
  offSiteOrigin: boolean;
}

/**
 * A refusal, as the desk sees it — with the STAFF-DIRECTIVE message the
 * member's phone never received.
 *
 * `staffMessage` is recomputed from the member's CURRENT membership rather
 * than replayed from the moment of denial, and that is deliberate: by the time
 * a staffer reads this card the useful question is "what do I sell them right
 * now", not "what was true ninety seconds ago". A renewal rung up in between
 * should make the card say so.
 */
export interface DeskDenial {
  denialId: string;
  member: DeskMember;
  at: string;
  reason: DenialReason;
  staffMessage: string;
  outcome: 'UNRESOLVED' | 'RESOLVED_WALK_IN' | 'OVERRIDDEN' | 'ABANDONED';
  /** The photograph-and-forward signature. Present only on STATION_TOKEN_EXPIRED. */
  tokenStalenessSeconds: number | null;
  offSiteOrigin: boolean;
  station: { code: string; name: string } | null;
}

export interface DeskCounters {
  /** Open visits right now. */
  inGym: number;
  /** Non-voided admissions on today's gym-local business date. */
  today: number;
  /**
   * UNRESOLVED denials for a reason the desk can actually sell against.
   *
   * `GYM_CLOSED`, `CHECKIN_DAILY_LIMIT` and `STATION_TOKEN_EXPIRED` are
   * excluded — they would otherwise sit UNRESOLVED forever and poison the
   * conversion rate. One WHERE clause, no enum change.
   */
  needsYou: number;
  /**
   * Staff-recorded entries today. It was a fraud signal; it is now ALSO a
   * coverage signal, and a high number usually means the wifi is bad rather
   * than that staff is cheating.
   */
  manualToday: number;
}

/** Whether the display is still painting. */
export interface DeskStationStatus {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  lastTokenIssuedAt: string | null;
  /**
   * `now − lastTokenIssuedAt` inside two batch windows. Derived from a column
   * the display already writes on every mint, which is why there is no
   * separate heartbeat endpoint to forget to call.
   */
  live: boolean;
}

/**
 * `GET /front-desk/today?since=` — the 3-second polling fallback for the SSE
 * feed AND its reconnect catch-up, which is what keeps the fallback from ever
 * being dead code.
 */
export interface DeskTodayPayload {
  serverTime: string;
  /** Opaque. Pass back as `?since=` to get only what changed. */
  cursor: string;
  counters: DeskCounters;
  arrivals: DeskArrival[];
  denials: DeskDenial[];
  stations: DeskStationStatus[];
}

/**
 * One recorded visit, as the desk sees it after the fact.
 *
 * Returned by the check-out and void routes — the two that act on a visit that
 * already exists rather than creating one. It carries `DeskMember`, so the
 * same privacy boundary applies here as on the live feed.
 */
export interface CheckInRecord {
  checkInId: string;
  member: DeskMember;
  entryType: 'MEMBERSHIP' | 'WALK_IN' | 'GUEST_PASS';
  verdict: AccessVerdict;
  method: CheckInMethod;
  occurredAt: string;
  endedAt: string | null;
  /** Null while the visit is still open. */
  durationMinutes: number | null;
  closeMethod: 'STATION_QR' | 'MANUAL' | 'AUTO_CLOSE' | 'STALE_CLOSE' | null;
  /**
   * Excluded from every duration statistic. True for both AUTO_CLOSE and
   * STALE_CLOSE — a visit the member never closed is not a measured session.
   */
  autoClosed: boolean;
  /** Recorded rather than hidden, so a dispute can see a visit was reopened. */
  reopenCount: number;
  station: { code: string; name: string } | null;
  /**
   * The WALK_IN Payment that funded this entry (CheckIn.paymentId @unique,
   * 1:1). NULL for MEMBERSHIP and GUEST_PASS entries — a guest pass is spent
   * from a host's allowance and writes no Payment at all. An opaque uuid
   * carrying no money; fetching anything with it still needs payment.read.
   */
  paymentId: string | null;
  voidedAt: string | null;
  voidReason: string | null;
}

/**
 * `GET /me/check-ins` — the member's own visit history.
 *
 * Deliberately NARROWER than `CheckInRecord`: no `DeskMember`, because a
 * member reading their own history does not need a projection of themselves,
 * and no `offSiteOrigin` or staleness, because those are fraud signals for
 * staff rather than facts a member should be shown about their own visits.
 */
export interface MyCheckIn {
  id: string;
  occurredAt: string;
  businessDate: CivilDate;
  endedAt: string | null;
  /** Null while the visit is open. */
  durationMinutes: number | null;
  method: CheckInMethod;
  entryType: 'MEMBERSHIP' | 'WALK_IN' | 'GUEST_PASS';
  /** Null on a desk-recorded entry. */
  station: { code: string; name: string } | null;
}

/** `GET /me/check-ins/summary` — every number the portal's dashboard renders. */
export interface MyCheckInSummary {
  thisMonth: number;
  allTime: number;
  avgPerWeek: number;
  /**
   * WEEKS, not days. A daily streak punishes a rest day, which is exactly the
   * behaviour a gym does not want; a weekly one rewards turning up most weeks.
   */
  currentStreakWeeks: number;
  longestStreakWeeks: number;
  /** Sparse — one entry per day that had a visit, oldest first. */
  days: { date: CivilDate; count: number }[];
}

/**
 * One gym-local day in the admin attendance trend.
 *
 * `total` counts admitted visits only and excludes voided rows, which is what
 * `GET /front-desk/today` already does (`front-desk.service.ts` filters
 * `voidedAt: null`) — the two are rendered side by side on the dashboard and a
 * disagreement between them would be read as a bug in whichever number the
 * viewer trusted less.
 *
 * `selfScan + staff === total` always: `CheckInMethod` has exactly three
 * members and STATION_QR is the only self-serve one.
 */
export interface DailyCheckInPoint {
  date: CivilDate;
  /** Admitted visits, voids excluded. */
  total: number;
  /** method = STATION_QR — the member scanned the counter code themselves. */
  selfScan: number;
  /** method IN (MEMBER_CODE, MANUAL) — recorded by a named operator. */
  staff: number;
  /** Refusals on the same business date. A separate table, not a CheckIn. */
  denied: number;
}

/**
 * `GET /admin/check-ins/daily` — the dashboard's attendance trend.
 *
 * DENSE, NOT SPARSE. Every date in the requested range appears, including days
 * with no visits at all. `MyCheckInSummary.days` is deliberately sparse because
 * it feeds a heat map where an absent day is simply not drawn; a line chart
 * given a gap interpolates straight across a closed holiday and draws
 * attendance the gym never had.
 */
export interface DailyCheckIns {
  from: CivilDate;
  to: CivilDate;
  days: DailyCheckInPoint[];
}
