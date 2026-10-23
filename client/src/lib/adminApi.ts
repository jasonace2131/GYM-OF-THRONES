'use client';

import type { ClassSession } from './classes';
import type {
  AccessDecision,
  AccessVerdict,
  Announcement,
  ActiveCheckIn,
  AllowReason,
  AnnouncementDoc,
  AnnouncementImageUpload,
  AnnouncementUploadStatus,
  CheckInRecord,
  CheckInResult,
  ClassRegisterEntryWire,
  DailyCheckIns,
  DenialReason,
  DeskTodayPayload,
  GymEquipmentInput,
  GymEquipmentItem,
  MembershipStatus,
  PaginatedData,
  PublicGymConfig,
} from '@got/shared';
import { apiFetch } from './api';
import {
  markResultFromWire,
  registerEntryFromWire,
  type MarkResult,
  type MarkResultReply,
  type RegisterEntryReply,
} from './classRegister';
import type { ReceiptDoc } from './receipt/receiptDoc';

/**
 * The CRM's read surface, typed once.
 *
 * Every shape here mirrors a server presenter. They are declared rather than
 * imported from the server because the server is a separate build and its
 * presenters are internal — but each one names the file it mirrors, so a
 * change on either side has an obvious partner to check.
 */

/** Mirrors `server/src/users/members.presenter.ts`. */
export interface MemberListItem {
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  role: 'CLIENT' | 'FRONT_DESK' | 'COACH' | 'ADMIN' | 'DEV';
  status: 'ACTIVE' | 'SUSPENDED' | 'DEACTIVATED';
  joinedOn: string;
  lastSeenAt: string | null;
  /** Non-null ONLY under `members({ deleted: true })` — every other read
   *  filters soft-deleted members out. It is what tells a drawer opened from
   *  the Deleted view to offer Restore instead of the destructive menu. */
  deletedAt: string | null;
  /** Free text, staff-entered via `PATCH /members/:id`. Null until set. */
  emergencyContact: string | null;
  /**
   * `graceDays` is deliberately absent, and stayed absent when the
   * Subscriptions screen merged into this list. `MembershipListItem` below
   * carries it and no screen ever rendered it; the fact a staffer needs is
   * `decision === 'GRACE'`, which is already on the row.
   */
  membership: {
    id: string;
    planCode: string;
    planName: string;
    status: MembershipStatus;
    startsOn: string;
    endsOn: string;
    daysRemaining: number | null;
    /** The date notice was given, or null. The roster's "cancelling" sub-line:
     *  a member already leaving is the one row on a renewal call sheet nobody
     *  should ring about renewing. */
    cancelRequestedOn: string | null;
  } | null;
  decision: 'ALLOW' | 'GRACE' | 'DENY';
  allowReason: string | null;
  denialReason: string | null;
  checkInCount: number;
}

/**
 * Mirrors `MemberCounts` (`server/src/users/members.service.ts`).
 *
 * `expiring` is a SUBSET of `active` — both are `endsOn >= today` — so these
 * numbers deliberately overlap and the tiles say so rather than pretending to
 * partition. `none` is "signed up, never bought a plan", which is the whole
 * argument for a member roster existing beside a subscription list and which
 * no screen has ever shown.
 */
export interface MemberCounts {
  active: number;
  expiring: number;
  expired: number;
  none: number;
  total: number;
  /** From `MEMBERSHIP_EXPIRING_SOON_DAYS` (1–30, default 7). The tile reads
   *  its caption off this, never off a literal. */
  expiringSoonDays: number;
}

/** Every role `POST /members/:id/role` accepts — built from the server's
 *  `ASSIGNABLE_ROLES` (`server/src/users/dto/change-role.dto.ts`), which is
 *  every `Role` except `DEV`. */
export type AssignableRole = 'CLIENT' | 'FRONT_DESK' | 'COACH' | 'ADMIN';

/**
 * `DiscountType` / `PaymentMethod` / `PaymentPurpose` as literal unions
 * rather than the `@got/shared` TS enums those DTOs declare. A TS string enum
 * is nominal — typing these fields as the enum itself would force every call
 * site to `import` and reference e.g. `PaymentMethod.CASH` just to pass a
 * matching string. `sellWalkIn` below already settled this the other way
 * (`method?: 'CASH' | 'GCASH'`), so new money wrappers match it. Every value
 * here is checked against `shared/src/types/membership.types.ts`, never guessed.
 */
export type PaymentMethodCode = 'CASH' | 'GCASH';
export type PaymentPurposeCode = 'MEMBERSHIP' | 'WALK_IN' | 'FREEZE_FEE';
export type DiscountTypeCode =
  'NONE' | 'SENIOR' | 'PWD' | 'PROMO' | 'STAFF' | 'GUEST_PASS' | 'GOODWILL';

/** Mirrors `AssignPlanDto` (`server/src/users/dto/create-member.dto.ts`) —
 *  `POST /members`'s optional "sign up and pay in one submit" step. */
export interface MemberPlanAssignment {
  planCode: string;
  discountType?: DiscountTypeCode;
  discountCentavos?: number;
  statutoryIdNo?: string;
  discountReason?: string;
  method: PaymentMethodCode;
  reference?: string;
  gcashVerified?: boolean;
  receiptNo?: string;
  notes?: string;
}

/** Mirrors `MembersService.create`'s result type. `planSaleError` is present
 *  only when `plan` was given and the sale failed — the member row still
 *  exists either way. */
export interface CreateMemberResult {
  member: MemberListItem;
  emailSent: boolean;
  planSaleError?: { code: string; message: string };
}

/** Mirrors `server/src/membership/membership.presenter.ts`. */
/** A membership on the Notifications panel's expiry alerts. */
export interface MembershipAlertItem extends MembershipListItem {
  /** When staff archived this term's alert; null while it is open. */
  alertArchivedAt: string | null;
}

export interface MembershipListItem {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planCode: string;
  planName: string;
  status: MembershipStatus;
  startsOn: string;
  endsOn: string;
  graceDays: number;
  cancelRequestedOn: string | null;
  daysRemaining: number | null;
  decision: 'ALLOW' | 'GRACE' | 'DENY';
  allowReason: string | null;
  denialReason: string | null;
}

/** Mirrors `AccessResult` (`server/src/membership/access-verdict.ts`) — the
 *  door ladder's verdict, embedded in `MembershipDetail`. */
export interface MembershipVerdict {
  decision: AccessDecision;
  verdict: AccessVerdict | null;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;
  message: string;
  relevantDate: string | null;
  daysRemaining: number | null;
  graceDaysRemaining: number;
  offer: 'NONE' | 'RENEW' | 'UNFREEZE' | 'OVERRIDE' | 'MANAGER';
}

/** Mirrors `HoldView` (`server/src/membership/membership.presenter.ts`). */
export interface MembershipHoldView {
  id: string;
  status: string;
  startsOn: string;
  endsOn: string;
  daysRequested: number;
  daysApplied: number;
  reason: string;
  feeWaived: boolean;
  releasedAt: string | null;
}

/** Mirrors `MembershipEventView` (`server/src/membership/membership.presenter.ts`). */
export interface MembershipEventView {
  id: string;
  type: string;
  fromStatus: MembershipStatus | null;
  toStatus: MembershipStatus;
  previousEndsOn: string | null;
  newEndsOn: string | null;
  reason: string | null;
  actorId: string | null;
  paymentId: string | null;
  effectiveAt: string;
}

/**
 * Mirrors `MembershipDetail` (`server/src/membership/membership.presenter.ts`)
 * — what every membership write route (sell, renew, freeze, cancel, ...)
 * returns, unlike `MembershipListItem` which is the roster row shape.
 */
export interface MembershipDetail {
  id: string;
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  planId: string;
  planCode: string;
  planName: string;
  planPriceCentavos: number;
  termMonths: number;
  status: MembershipStatus;
  startsOn: string;
  endsOn: string;
  graceDays: number;
  billingAnchorDay: number;
  joinedOn: string;
  cancelRequestedOn: string | null;
  cancelledOn: string | null;
  graceAdmissionsThisTerm: number;
  freezesUsedThisTerm: number;
  guestPassesPerTerm: number;
  guestPassesRemaining: number;
  purchasedAt: string;
  verdict: MembershipVerdict;
  hold: MembershipHoldView | null;
  events: MembershipEventView[];
  /** Present only when the caller resolved `payment.read`. */
  payments?: PaymentSummary[];
}

/**
 * Mirrors `server/src/payments/payment.presenter.ts`'s `toPaymentSummary()`
 * FIELD FOR FIELD.
 *
 * This type previously carried `gcashReference`/`memberName`/`memberCode`,
 * none of which the presenter has ever sent — a pre-existing mismatch flagged
 * in C4's report and fixed here, before C5 wires a payments UI against it.
 * There is no member name/code on the wire at all: the presenter sends
 * `userId` only, so a caller wanting the person has to already hold the row
 * (`MemberListItem`) rather than read it off a payment.
 */
export interface PaymentSummary {
  id: string;
  userId: string | null;
  payerName: string | null;
  membershipId: string | null;
  purpose: PaymentPurposeCode;
  status: 'RECORDED' | 'VOIDED';
  planCode: string;
  planName: string;
  grossCentavos: number;
  vatBaseCentavos: number;
  discountType: DiscountTypeCode;
  discountCentavos: number;
  netCentavos: number;
  vatExempt: boolean;
  statutoryIdNo: string | null;
  discountReason: string | null;
  termMonths: number | null;
  termStartsOn: string | null;
  termEndsOn: string | null;
  method: PaymentMethodCode;
  reference: string | null;
  receiptNo: string | null;
  receiptIssued: boolean;
  receivedAt: string;
  businessDate: string;
  shiftId: string;
  recordedById: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidReason: string | null;
  /** `null` unless the payment is voided (`Payment_void_kind_shape`). Not in
   *  `@got/shared` — the presenter's own comment says nothing outside the
   *  server switches on it, so it travels as an opaque badge string here. */
  voidKind: 'VOID' | 'REFUND' | null;
  notes: string | null;
}

export interface PaymentListResult extends PaginatedData<PaymentSummary> {
  totalCentavos: number;
  byMethod: Record<string, number>;
}

/**
 * Mirrors `server/src/payments/payment-detail.presenter.ts`.
 *
 * A PRIVACY BOUNDARY on the server side, and the fields it refuses to send
 * are named here so nobody adds them speculatively: `proofPath` (an object key
 * in a private bucket), `referenceNormalized`, `idempotencyKey`/`Hash`,
 * `guestPhone` (behind `member.create` on a different route entirely) and
 * `planId`. `hasProof` is the boolean that answers the only question the
 * drawer asks.
 */
export interface PaymentDetail extends PaymentSummary {
  /** The same derivation the printed slip carries. */
  docNo: string;
  payerMemberCode: string | null;
  recordedByName: string;
  voidedByName: string | null;
  archivedByName: string | null;
  archivedAt: string | null;
  gcashVerified: boolean;
  gcashVerifiedAt: string | null;
  gcashVerifiedByName: string | null;
  hasProof: boolean;
  replacesPaymentId: string | null;
  replacedByPaymentId: string | null;
  /** Name only — the server never sends a guest's phone on this key. */
  checkIn: { id: string; occurredAt: string; guestName: string | null } | null;
  membership: { id: string; planName: string } | null;
  /**
   * Whether the gym is VAT-registered, which decides the statutory branch of
   * `computeAmounts`. It travels on the payment so the amend preview never
   * has to GUESS it — a client that assumed either way would show a figure
   * the server does not write.
   */
  vatRegistered: boolean;
}

/**
 * The body `POST /payments/:id/amend` accepts — mirrors `AmendPaymentDto`.
 *
 * THERE IS NO AMOUNT FIELD, and there must not be one. Every amount in this
 * system is derived from the plan's list price and the discount; "fix a wrong
 * amount" is fix the plan, the discount or the method.
 *
 * `''` in `receiptNo` / `notes` / `reference` is a CLEAR; omitting a field
 * inherits the original.
 */
export interface AmendPaymentBody {
  reason: string;
  planCode?: string;
  userId?: string;
  method?: PaymentMethodCode;
  reference?: string;
  gcashVerified?: boolean;
  discountType?: DiscountTypeCode;
  discountCentavos?: number;
  statutoryIdNo?: string;
  discountReason?: string;
  receiptNo?: string;
  notes?: string;
}

/** Mirrors `server/src/admin/station.presenter.ts`. */
export interface AdminStationCredential {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  isActive: boolean;
}

export interface AdminStation {
  id: string;
  code: string;
  name: string;
  gymCode: string;
  tokenEpoch: number;
  isActive: boolean;
  lastTokenIssuedAt: string | null;
  checkInCount: number;
  credentials: AdminStationCredential[];
}

export interface IssuedStationCredential {
  credential: AdminStationCredential;
  secret: string;
  stationCode: string;
}

/**
 * Mirrors `server/src/catalogue/plan.presenter.ts`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS DECLARED `isArchived`. THE SERVER SENDS `isActive`.
 *
 * There is no mapping layer, so the field was permanently `undefined`. Two
 * consequences, both silent: the Settings badge could only ever render "On
 * sale", and `RecordPaymentModal`'s `!p.isArchived` filter was a no-op that
 * evaluated `!undefined === true` for every plan. It was masked only because
 * `plans()` never asked for archived rows, so none were ever returned —
 * which the editor below changes immediately.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface AdminPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  kind: string;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
  isActive: boolean;
}

/** Mirrors `server/src/config/opening-hours.service.ts`. */
export interface DayHours {
  /** 0 = Sunday … 6 = Saturday, matching `Date.getDay()`. */
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

/** Mirrors `AssistantSettingsView` in `server/src/assistant/admin-assistant.controller.ts`. */
export interface AssistantSettingsView {
  instructions: string;
  isDefault: boolean;
  defaultInstructions: string;
  /** Read-only: the server appends these to whatever is saved. */
  safetyRules: string;
  maxLength: number;
  /** ISO-8601, or null on the built-in default. */
  updatedAt: string | null;
  updatedByName: string | null;
  /** False when the server has no Gemini key: editing works, Try it cannot answer. */
  enabled: boolean;
}

export interface AssistantDraftAnswer {
  answer: string;
  model: string;
}

/** Mirrors `server/src/payments/reports.service.ts`. */
export type RevenueGroup = 'month' | 'plan' | 'method' | 'purpose';

export interface RevenueReport {
  from: string;
  to: string;
  groupBy: RevenueGroup;
  series: {
    key: string;
    label: string;
    centavos: number;
    count: number;
    discountCentavos: number;
  }[];
  totalCentavos: number;
  totalCount: number;
  totalDiscountCentavos: number;
}

/** Mirrors `WalkInStatsReport` (`server/src/payments/reports.service.ts`). */
export interface WalkInStatsReport {
  from: string;
  to: string;
  totalWalkIns: number;
  revenueCentavos: number;
  averagePerDay: number;
  converted: number;
  byDay: {
    weekday: string;
    count: number;
    revenueCentavos: number;
    peakHour: string | null;
  }[];
}

/**
 * Mirrors `MembershipActivityRow` (`server/src/payments/reports.service.ts`).
 *
 * `planCode`/`planName`/`netCentavos` are the plan AS SOLD at the time of the
 * event, taken from the joined Payment — not the member's plan today. See the
 * server's column-at-the-time note; reading them off the membership snapshot
 * prints this month's plan name against a six-month-old row.
 */
export type MembershipActivityType =
  'PURCHASED' | 'RENEWED' | 'REACTIVATED' | 'CANCELLED' | 'EXPIRED';

export interface MembershipActivityRow {
  eventId: string;
  membershipId: string;
  /** Gym-local civil date of the event, not its UTC date. */
  businessDate: string;
  effectiveAt: string;
  type: MembershipActivityType;
  memberName: string;
  memberCode: string | null;
  planCode: string;
  planName: string;
  /** Null when no money caused the event — an EXPIRED, most CANCELLEDs. */
  netCentavos: number | null;
  /** Where the event left the term, or null when it did not move it. */
  newEndsOn: string | null;
}

export interface MembershipActivityReport {
  from: string;
  to: string;
  items: MembershipActivityRow[];
  total: number;
  /** The window held more rows than the server's ceiling returns. */
  truncated: boolean;
  counts: Record<MembershipActivityType, number>;
  revenueCentavos: number;
}

export interface RecurringReport {
  asOf: string;
  activeMembers: number;
  mrrCentavos: number;
  arpuCentavos: number;
  renewedLast30: number;
  lapsedLast30: number;
  /** Null when no term came up in the window — different from zero churn. */
  churnRate: number | null;
}

/** Mirrors `server/src/contact/contact.service.ts`. */
export type LeadStatus = 'NEW' | 'CONTACTED' | 'CONVERTED' | 'LOST';

export interface Lead {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: string;
  status: LeadStatus;
  assignedToId: string | null;
  notes: string | null;
  /**
   * False means the enquiry is saved but the gym was never emailed about it.
   * Worth surfacing: it is the difference between "nobody has replied yet"
   * and "nobody knows this exists".
   */
  emailSent: boolean;
  convertedUserId: string | null;
  createdAt: string;
}

/** `POST /admin/plans`. `code` is immutable once a plan exists — see below. */
export interface CreatePlanInput {
  code: string;
  name: string;
  description?: string;
  kind: 'TERM' | 'WALK_IN';
  priceCentavos: number;
  termMonths?: number | null;
  freezable?: boolean;
  guestPassesPerTerm?: number;
  graceDays?: number;
  perks?: string[];
  sortOrder?: number;
}

/**
 * `PATCH /admin/plans/:id`.
 *
 * `code` is ABSENT, not optional. It is snapshotted onto `Membership.planCode`
 * and `Payment.planCode` at sale time, so changing it would orphan every
 * historical row from the plan they name. `forbidNonWhitelisted` is on
 * globally, so sending one is a 400 rather than a silent no-op.
 */
export type UpdatePlanInput = Partial<Omit<CreatePlanInput, 'code' | 'kind'>>;

/**
 * A row on the Notifications board's right-hand column (Figure 22, REQ021).
 *
 * The LEFT column has no type here and never will: expiration alerts are
 * `memberships({ expiringWithinDays })`, the same query the Subscriptions
 * screen runs, derived on every load rather than stored. A second shape for
 * the same rows would be a second thing to keep true.
 */
export interface SystemNotification {
  id: string;
  kind: 'LEAD_RECEIVED' | 'NIGHTLY_JOB' | 'NIGHTLY_JOB_FAILED';
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  body: string | null;
  /** An in-app path. The database refuses anything that is not one. */
  linkPath: string | null;
  subjectType: string | null;
  subjectId: string | null;
  readAt: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

/**
 * One line of the audit trail.
 *
 * `actorRole` is the role that account held AT THE TIME, not now — an admin
 * demoted next month must not retroactively appear to have suspended somebody
 * as a front-desk operator.
 *
 * There is no `originIpHash` here and there should not be. It is stored for
 * forensics, not for a table in a back office.
 */
export interface AuditEntry {
  id: string;
  action:
    | 'PAYMENT_VOIDED'
    // A payment corrected: the original voided and a replacement written in
    // its place, in one transaction, in the original's own shift.
    | 'PAYMENT_AMENDED'
    // Hidden from the register and put back. Neither moves a figure.
    | 'PAYMENT_ARCHIVED'
    | 'PAYMENT_UNARCHIVED'
    | 'CHECKIN_OVERRIDDEN'
    | 'CHECKIN_VOIDED'
    | 'MEMBER_SUSPENDED'
    | 'MEMBER_REACTIVATED'
    | 'MEMBER_DELETED'
    | 'MEMBER_RESTORED'
    | 'ROLE_CHANGED'
    // Counter sign-up: staff corrected a never-signed-in member's email ({ before, after }).
    | 'MEMBER_EMAIL_CHANGED'
    // ── Staff & Access ──
    // An invitation issued, re-sent with a fresh link, withdrawn and taken
    // up; ACCEPTED carries the { before, after } role pair.
    | 'STAFF_INVITED'
    | 'STAFF_INVITE_RESENT'
    | 'STAFF_INVITE_REVOKED'
    | 'STAFF_INVITE_ACCEPTED'
    | 'COACH_PROFILE_UPDATED'
    // ── end Staff & Access ──
    | 'PLAN_UPDATED'
    | 'PLAN_ARCHIVED'
    | 'OPENING_HOURS_CHANGED'
    // The noticeboard: posting, editing (pin and unpin included) and deleting.
    // `details.fields` names what changed; the body's text is never copied.
    | 'ANNOUNCEMENT_CREATED'
    | 'ANNOUNCEMENT_UPDATED'
    | 'ANNOUNCEMENT_DELETED'
    // A coach correcting or removing a member's recorded progress. `details`
    // names the FIELDS that changed, never their values: `audit.read` is not
    // a progress key, and this screen must not become a way to read weights.
    | 'PROGRESS_MEASUREMENT_CORRECTED'
    | 'PROGRESS_MEASUREMENT_DELETED'
    | 'PROGRESS_GOAL_DELETED'
    // ── Coach tools (feat/coach-tools) ──
    // An admin read a coach-member conversation (chat.review), with a reason;
    // a sender withdrew a message; a coach saved a workout plan. `details`
    // carries counts and ids only — never a message or a plan.
    | 'CHAT_THREAD_REVIEWED'
    | 'CHAT_MESSAGE_DELETED'
    | 'WORKOUT_PLAN_SAVED'
    // ── AI assistant settings ── an admin saving new instructions
    // ({ before, after, wasDefault }) or putting the built-in ones back.
    | 'ASSISTANT_INSTRUCTIONS_UPDATED'
    | 'ASSISTANT_INSTRUCTIONS_RESET'
    // ── Gym equipment list ── an admin added, edited, removed or reordered
    // equipment ({ change, before?, after? }).
    | 'GYM_EQUIPMENT_CHANGED';
  actorId: string;
  actorName: string;
  actorRole: string;
  subjectType: string;
  subjectId: string | null;
  subjectLabel: string | null;
  reason: string | null;
  details: unknown;
  occurredAt: string;
}

export interface CoachAssignmentItem {
  id: string;
  coachId: string;
  coachName: string;
  memberId: string;
  memberName: string;
  memberCode: string | null;
  status: string;
  startedAt: string;
  endedAt: string | null;
}

/** A class as an API of either age sends it: the one before 2026-10-11 counted no waitlist. */
type ClassSessionReply = Omit<ClassSession, 'waitlistCount'> &
  Partial<Pick<ClassSession, 'waitlistCount'>>;

/**
 * `waitlistCount` read as 0 when the server sent none — the deploy window, see
 * `registerEntryFromWire`. Zero hides "· N waiting" for those few minutes
 * rather than printing "· undefined waiting" or counting NaN people in a
 * confirmation.
 */
function sessionFromWire(raw: ClassSessionReply): ClassSession {
  return { ...raw, waitlistCount: raw.waitlistCount ?? 0 };
}

/** `?a=1&b=2`, skipping anything unset. */
function qs(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered.length === 0 ? '' : `?${rendered}`;
}

export const adminApi = {
  /**
   * The timetable. `coachId` filters it to one coach — the server has accepted
   * that parameter since classes shipped and no client had ever passed it, so
   * "show me Ana's week" was unanswerable from any screen.
   *
   * `from`/`to` are inclusive gym days (yyyy-mm-dd). Omitted, the server shows
   * today and the next fortnight — which is how past classes, and their
   * registers, used to be unreachable from the console.
   */
  classSessions: (
    params: { from?: string; to?: string; coachId?: string } = {},
  ): Promise<ClassSession[]> =>
    apiFetch<ClassSessionReply[]>(`/class-sessions${qs(params)}`).then((rows) =>
      rows.map(sessionFromWire),
    ),

  /**
   * A start that has already passed is refused — 422 CLASS_ALREADY_STARTED,
   * whose message the console shows as it is.
   */
  createClassSession: (body: {
    title: string;
    description?: string;
    coachId: string;
    startsAt: string;
    endsAt: string;
    capacity: number;
  }): Promise<ClassSession> =>
    apiFetch<ClassSessionReply>('/admin/class-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    }).then(sessionFromWire),

  /**
   * Editing a scheduled class — REQ013's "modify", which had no client wrapper
   * and therefore no route into it from any screen. `PATCH /admin/class-sessions/:id`
   * has existed the whole time.
   *
   * Every field optional, and only the changed ones are sent:
   * `forbidNonWhitelisted` is on globally, so a stray property is a 400 rather
   * than a silent no-op, and sending an unchanged value would still bump
   * `updatedAt` for no reason.
   *
   * Moving a class that has not started to a start that has passed is refused
   * (422 CLASS_ALREADY_STARTED), and so is an end that has passed
   * (CLASS_FINISHED); the console shows either message as it is.
   */
  updateClassSession: (
    id: string,
    body: {
      title?: string;
      description?: string;
      coachId?: string;
      startsAt?: string;
      endsAt?: string;
      capacity?: number;
    },
  ): Promise<ClassSession> =>
    apiFetch<ClassSessionReply>(`/admin/class-sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }).then(sessionFromWire),

  cancelClassSession: (id: string, reason: string): Promise<ClassSession> =>
    apiFetch<ClassSessionReply>(`/admin/class-sessions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }).then(sessionFromWire),

  /**
   * Who is in a class. `booking.read` — never exposed to a member.
   *
   * The shared `ClassRegisterEntryWire`, not a shape written out here: the
   * register row used to exist in three hand-copied versions (the server's,
   * this one and the coach's), and the three drifted the first time one of
   * them gained a field. Read through `registerEntryFromWire`, so the API
   * this one replaces (no markers, no queue places) cannot crash it.
   */
  classRegister: (id: string): Promise<ClassRegisterEntryWire[]> =>
    apiFetch<RegisterEntryReply[]>(`/class-sessions/${id}/register`).then((rows) =>
      rows.map(registerEntryFromWire),
    ),

  /**
   * Marks one entry; the answer says who recorded it, and when — or, from the
   * API this one replaces, nothing about either (null). `booking.attend`.
   */
  markAttendance: (bookingId: string, attended: boolean): Promise<MarkResult> =>
    apiFetch<MarkResultReply>(`/admin/class-sessions/bookings/${bookingId}/attendance`, {
      method: 'POST',
      body: JSON.stringify({ attended }),
    }).then(markResultFromWire),

  /**
   * The desk putting a member into a class by hand — `booking.manage`.
   *
   * A free place books them straight in; a full class puts them on the
   * waitlist while it is still open; after that the server refuses
   * (WAITLIST_CLOSED) and the places have to be raised first. Plan and
   * booking-window rules do not apply to a staff add (owner, 2026-10-11) —
   * capacity always does. `apiFetch` mints the Idempotency-Key the route
   * requires, so a double-clicked confirm is one booking, not two.
   */
  addToClass: (sessionId: string, userId: string): Promise<ClassRegisterEntryWire> =>
    apiFetch<RegisterEntryReply>(`/admin/class-sessions/${sessionId}/bookings`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }).then(registerEntryFromWire),

  /**
   * Taking a member out of a class — `booking.manage`. The reason (3–300
   * characters, the CHECK on the row) is shown to the member in their notice.
   *
   * Typed `unknown` on purpose: the console reloads the register after a
   * removal instead of reading the answer, so nothing here should come to
   * depend on a shape no screen uses.
   */
  removeFromClass: (bookingId: string, reason: string): Promise<unknown> =>
    apiFetch<unknown>(`/admin/class-sessions/bookings/${bookingId}/remove`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * The console reads the SAME list the member portal does.
   *
   * There is no `GET /admin/announcements`: one query, one ordering, so the
   * board staff edit and the board members read can never disagree about what
   * is pinned or what is at the top.
   */
  announcements: (params: {
    page?: number;
    limit?: number;
  }): Promise<PaginatedData<Announcement>> =>
    apiFetch<PaginatedData<Announcement>>(`/announcements${qs(params)}`),

  /**
   * One body, two spellings: `contentJson` from the rich editor (the server
   * derives `content` from it), or plain `content`. Never both — the server
   * refuses that with ANNOUNCEMENT_CONTENT_INVALID.
   */
  createAnnouncement: (body: {
    title: string;
    content?: string;
    contentJson?: AnnouncementDoc;
    coverImageUrl?: string | null;
    isPinned?: boolean;
  }): Promise<Announcement> =>
    apiFetch<Announcement>('/admin/announcements', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `coverImageUrl: null` removes the cover; leaving it out leaves it alone. */
  updateAnnouncement: (
    id: string,
    body: {
      title?: string;
      content?: string;
      contentJson?: AnnouncementDoc;
      coverImageUrl?: string | null;
      isPinned?: boolean;
    },
  ): Promise<Announcement> =>
    apiFetch<Announcement>(`/admin/announcements/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  /** Whether the composer may offer images (false without SUPABASE_SERVICE_KEY). */
  announcementUploadStatus: (): Promise<AnnouncementUploadStatus> =>
    apiFetch<AnnouncementUploadStatus>('/admin/announcements/uploads'),

  /**
   * A signed URL for one already-resized image. The browser PUTs the bytes to
   * storage itself (`lib/announcements/imageUpload.ts`); they never pass
   * through the API.
   */
  signAnnouncementUpload: (body: {
    contentType: string;
    size: number;
  }): Promise<AnnouncementImageUpload> =>
    apiFetch<AnnouncementImageUpload>('/admin/announcements/uploads', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteAnnouncement: (id: string): Promise<Announcement> =>
    apiFetch<Announcement>(`/admin/announcements/${id}`, { method: 'DELETE' }),

  /**
   * One member by id — what the payments register needs to open somebody's
   * record from a row that only carries their `userId`.
   *
   * 404s rather than 403s on a scoped miss, deliberately: a 403 would confirm
   * the row exists and turn this into an enumeration oracle.
   */
  member: (id: string): Promise<MemberListItem> => apiFetch<MemberListItem>(`/members/${id}`),

  members: (params: {
    page?: number;
    limit?: number;
    search?: string;
    planCode?: string;
    standing?: string;
    /** The STORED `MembershipStatus`, which is NOT `standing`. The server has
     *  accepted it since the DTO shipped and no screen ever sent it. */
    membershipStatus?: string;
    role?: string;
    /** Soft-deleted members are excluded unless this is explicitly `true`. */
    deleted?: boolean;
    /** `ending` is the renewal call sheet's order — soonest-ending term
     *  first, planless members last. Omitted means `recent`. */
    sort?: 'recent' | 'ending';
  }): Promise<PaginatedData<MemberListItem>> =>
    apiFetch<PaginatedData<MemberListItem>>(`/members${qs(params)}`),

  /**
   * `GET /members/counts` — the roster's KPI tiles in one request.
   *
   * Takes the list's filters MINUS `standing` (it counts every standing at
   * once) and minus pagination (there is no page of anything to return).
   * `expiringSoonDays` comes back with the numbers so the tile's caption is
   * read from the same configured value the filter uses rather than a
   * hardcoded 7.
   */
  memberCounts: (
    params: { search?: string; planCode?: string; deleted?: boolean } = {},
  ): Promise<MemberCounts> => apiFetch<MemberCounts>(`/members/counts${qs(params)}`),

  /** `POST /members` — C2. `plan` mirrors `AssignPlanDto`; omit it for a bare account.
   *  `leadId` closes the funnel: the enquiry is marked CONVERTED with the new
   *  member's id in the same transaction that creates the account. */
  createMember: (body: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
    emergencyContact?: string;
    plan?: MemberPlanAssignment;
    leadId?: string;
    /** The guest visit this member was converted from — stamps the visit so
     *  the walk-in report can count conversions. */
    fromCheckInId?: string;
  }): Promise<CreateMemberResult> =>
    apiFetch<CreateMemberResult>('/members', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `PATCH /members/:id` — name, phone, emergency contact only. */
  updateMember: (
    id: string,
    body: { firstName?: string; lastName?: string; phone?: string; emergencyContact?: string },
  ): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  /** `POST /members/:id/suspend`. Check-in only — portal login is untouched. */
  suspendMember: (id: string, reason: string): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /** `POST /members/:id/reactivate`. No body — it unconditionally clears the suspension. */
  reactivateMember: (id: string): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}/reactivate`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** `DELETE /members/:id`. Soft — returns the pre-delete snapshot, not 204. */
  deleteMember: (id: string): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}`, { method: 'DELETE' }),

  /** `POST /members/:id/restore` — the undo for `deleteMember`, on the same
   *  `member.delete` permission. No body; 422 MEMBER_NOT_DELETED if the member
   *  was never soft-deleted. */
  restoreMember: (id: string): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}/restore`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /**
   * `POST /members/:id/role`. `role` is never `'DEV'` — see `AssignableRole`.
   * `reason` is what the confirmation asked for; it lands on the audit entry.
   */
  changeMemberRole: (id: string, role: AssignableRole, reason?: string): Promise<MemberListItem> =>
    apiFetch<MemberListItem>(`/members/${id}/role`, {
      method: 'POST',
      body: JSON.stringify(reason === undefined ? { role } : { role, reason }),
    }),

  /** `POST /members/:id/resend-invite` — the answer to `emailSent: false` from `createMember`. */
  resendInvite: (id: string): Promise<{ member: MemberListItem; emailSent: boolean }> =>
    apiFetch<{ member: MemberListItem; emailSent: boolean }>(`/members/${id}/resend-invite`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /** `POST /members/:id/change-email` — only for a member who has never signed
   *  in; sends the setup link to the new address. 409 MEMBER_ALREADY_SIGNED_IN
   *  otherwise, with copy the modal shows as-is. */
  changeMemberEmail: (
    id: string,
    email: string,
  ): Promise<{ member: MemberListItem; emailSent: boolean }> =>
    apiFetch<{ member: MemberListItem; emailSent: boolean }>(`/members/${id}/change-email`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  memberships: (params: {
    page?: number;
    limit?: number;
    search?: string;
    planCode?: string;
    status?: string;
    expiringWithinDays?: number;
  }): Promise<PaginatedData<MembershipListItem>> =>
    apiFetch<PaginatedData<MembershipListItem>>(`/memberships${qs(params)}`),

  /**
   * `POST /memberships` — route 22, assigning a plan to a member for the first
   * time (or after a lapsed one). Mirrors `CreateMembershipDto`; no `startsOn`
   * — §5.7.3's four cases are the server's decision, never the client's.
   */
  sellMembership: (body: {
    userId: string;
    planCode: string;
    discountType?: DiscountTypeCode;
    discountCentavos?: number;
    statutoryIdNo?: string;
    discountReason?: string;
    method: PaymentMethodCode;
    reference?: string;
    gcashVerified?: boolean;
    receiptNo?: string;
    notes?: string;
  }): Promise<MembershipDetail> =>
    apiFetch<MembershipDetail>('/memberships', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * `POST /memberships/:id/renew` — route 23, replacing the current term with
   * a new one on an existing membership. Mirrors `RenewMembershipDto`
   * (`CreateMembershipDto`'s fields minus `userId`, which comes from the path).
   */
  renewMembership: (
    id: string,
    body: {
      planCode: string;
      discountType?: DiscountTypeCode;
      discountCentavos?: number;
      statutoryIdNo?: string;
      discountReason?: string;
      method: PaymentMethodCode;
      reference?: string;
      gcashVerified?: boolean;
      receiptNo?: string;
      notes?: string;
    },
  ): Promise<MembershipDetail> =>
    apiFetch<MembershipDetail>(`/memberships/${id}/renew`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** `POST /memberships/:id/freeze` — route 26, ADMIN only. `endsOn` is mandatory (§5.6). */
  freezeMembership: (
    id: string,
    body: {
      startsOn: string;
      endsOn: string;
      reason: string;
      feeWaived?: boolean;
      method?: PaymentMethodCode;
      reference?: string;
      gcashVerified?: boolean;
      receiptNo?: string;
    },
  ): Promise<MembershipDetail> =>
    apiFetch<MembershipDetail>(`/memberships/${id}/freeze`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * `POST /memberships/:id/cancel` — route 28. Dangerous: forfeits the rest of
   * a paid term, ADMIN only. `confirm: true` matches `voidCheckIn`'s idiom.
   */
  cancelMembership: (id: string, reason: string): Promise<MembershipDetail> =>
    apiFetch<MembershipDetail>(`/memberships/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason }),
    }),

  payments: (params: {
    page?: number;
    limit?: number;
    method?: string;
    from?: string;
    to?: string;
    userId?: string;
    /** 'WALKIN' is the day-pass takings register. */
    planCode?: string;
    status?: 'RECORDED' | 'VOIDED';
    discountType?: DiscountTypeCode;
    shiftId?: string;
    /** Archived rows are excluded by default; `true` shows ONLY them. */
    archived?: boolean;
  }): Promise<PaymentListResult> => apiFetch<PaymentListResult>(`/payments${qs(params)}`),

  /** `GET /payments/:id` — one payment, for the register's detail drawer. */
  payment: (id: string): Promise<PaymentDetail> => apiFetch<PaymentDetail>(`/payments/${id}`),

  /** `GET /payments/:id/receipt` — the printable Transaction Slip's data. */
  paymentReceipt: (id: string): Promise<ReceiptDoc> =>
    apiFetch<ReceiptDoc>(`/payments/${id}/receipt`),

  /**
   * `POST /payments` — a counter sale outside a membership transaction
   * (WALK_IN only; the service refuses anything else). Mirrors `RecordPaymentDto`.
   */
  recordPayment: (body: {
    purpose: PaymentPurposeCode;
    planCode: string;
    userId?: string;
    grossCentavos: number;
    netCentavos?: number;
    discountType?: DiscountTypeCode;
    discountCentavos?: number;
    statutoryIdNo?: string;
    discountReason?: string;
    method: PaymentMethodCode;
    reference?: string;
    gcashVerified?: boolean;
    receiptNo?: string;
    receivedAt?: string;
    notes?: string;
  }): Promise<PaymentSummary> =>
    apiFetch<PaymentSummary>('/payments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * `POST /payments/:id/void`. `kind` tells apart the two reasons a payment
   * ends up VOIDED — `'VOID'` (recorded in error, no money moved) vs
   * `'REFUND'` (money returned). `confirm: true` matches `voidCheckIn`'s idiom.
   */
  voidPayment: (id: string, reason: string, kind: 'VOID' | 'REFUND'): Promise<PaymentSummary> =>
    apiFetch<PaymentSummary>(`/payments/${id}/void`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason, kind }),
    }),

  /**
   * `POST /payments/:id/amend` — "Edit payment".
   *
   * ONE transaction voids the original and writes a corrected replacement in
   * its place, in the SAME shift and on the SAME business day, because an
   * amendment moves no money. The response is the REPLACEMENT, which carries a
   * different id from the row the caller opened.
   *
   * `confirm: true` matches `voidPayment`'s idiom.
   */
  amendPayment: (id: string, body: AmendPaymentBody): Promise<PaymentSummary> =>
    apiFetch<PaymentSummary>(`/payments/${id}/amend`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, ...body }),
    }),

  /**
   * `POST /payments/:id/archive` and `/unarchive`.
   *
   * A SOFT DELETE, mirroring `User.deletedAt`. It hides a row from the
   * register and changes NO figure — no report, shift closure or BIR register
   * reads it. That is why there is no `confirm` on the wire: the dialog that
   * explains it lives in the console, and the route itself is reversible.
   */
  archivePayment: (id: string): Promise<PaymentSummary> =>
    apiFetch<PaymentSummary>(`/payments/${id}/archive`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  unarchivePayment: (id: string): Promise<PaymentSummary> =>
    apiFetch<PaymentSummary>(`/payments/${id}/unarchive`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  /**
   * `GET /check-ins` — routes 53/54's report, unscoped attendance history
   * (`checkin.read`). Pass `userId` for one member's history; voided visits
   * are excluded unless `includeVoided` is set.
   */
  checkIns: (
    params: {
      page?: number;
      limit?: number;
      userId?: string;
      stationId?: string;
      from?: string;
      to?: string;
      method?: string;
      entryType?: string;
      includeVoided?: boolean;
      openOnly?: boolean;
    } = {},
  ): Promise<PaginatedData<CheckInRecord>> =>
    apiFetch<PaginatedData<CheckInRecord>>(`/check-ins${qs(params)}`),

  activeCheckIns: (
    params: { page?: number; limit?: number } = {},
  ): Promise<PaginatedData<ActiveCheckIn>> =>
    apiFetch<PaginatedData<ActiveCheckIn>>(`/front-desk/check-ins/active${qs(params)}`),

  /** `GET /front-desk/check-ins/:id/guest` — the "Make member" hand-off.
   *  Gated on `member.create` server-side: the one read allowed past the
   *  DeskMember boundary, because the caller is about to create the account
   *  this data seeds. 404 for anything that is not a guest visit. */
  checkInGuest: (
    id: string,
  ): Promise<{
    guestName: string | null;
    guestPhone: string | null;
    guestEmail: string | null;
    guestEmergencyContact: string | null;
  }> =>
    apiFetch<{
      guestName: string | null;
      guestPhone: string | null;
      guestEmail: string | null;
      guestEmergencyContact: string | null;
    }>(`/front-desk/check-ins/${id}/guest`),

  today: (since?: string): Promise<DeskTodayPayload> =>
    apiFetch<DeskTodayPayload>(`/front-desk/today${qs({ since })}`),

  stations: (): Promise<AdminStation[]> => apiFetch<AdminStation[]>('/admin/stations'),

  updateStation: (
    id: string,
    body: { name?: string; isActive?: boolean; bumpTokenEpoch?: boolean },
  ): Promise<AdminStation> =>
    apiFetch<AdminStation>(`/admin/stations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  issueStationCredential: (id: string, label: string): Promise<IssuedStationCredential> =>
    apiFetch<IssuedStationCredential>(`/admin/stations/${id}/credentials`, {
      method: 'POST',
      body: JSON.stringify({ label }),
    }),

  revokeStationCredential: (credentialId: string): Promise<AdminStationCredential> =>
    apiFetch<AdminStationCredential>(`/admin/stations/credentials/${credentialId}`, {
      method: 'DELETE',
    }),

  /**
   * Route 45 — record a member by hand.
   *
   * `apiFetch` mints the `Idempotency-Key` for every POST, which is what makes
   * a double-tapped button at a busy counter free rather than a second visit.
   */
  manualCheckIn: (body: {
    userId?: string;
    memberCode?: string;
    identityConfirmed?: boolean;
  }): Promise<CheckInResult> =>
    apiFetch<CheckInResult>('/front-desk/check-ins', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  checkOut: (checkInId: string): Promise<CheckInRecord> =>
    apiFetch<CheckInRecord>(`/front-desk/check-ins/${checkInId}/checkout`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  voidCheckIn: (checkInId: string, reason: string): Promise<CheckInRecord> =>
    apiFetch<CheckInRecord>(`/front-desk/check-ins/${checkInId}/void`, {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason }),
    }),

  /**
   * Route 49. `denialId` is what closes the sales funnel — it moves the denial
   * to RESOLVED_WALK_IN and points it at the entry that converted it.
   */
  sellWalkIn: (body: {
    kind: 'WALK_IN' | 'GUEST_PASS';
    userId?: string;
    hostMembershipId?: string;
    guestName?: string;
    /** Required by the server for a guest with no account (owner, 2026-10-14). */
    guestEmail?: string;
    guestPhone?: string;
    method?: 'CASH' | 'GCASH';
    reference?: string;
    gcashVerified?: boolean;
    receiptNo?: string;
    discountType?: string;
    statutoryIdNo?: string;
    denialId?: string;
    /** Required for a guest with no account — the server 422s without it. */
    guestWaiverAccepted?: boolean;
    guestEmergencyContact?: string;
  }): Promise<CheckInRecord> =>
    apiFetch<CheckInRecord>('/front-desk/walk-ins', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  currentShift: (): Promise<{ id: string; openedAt: string } | null> =>
    apiFetch<{ id: string; openedAt: string } | null>('/shifts/current'),

  openShift: (openingFloatCentavos: number): Promise<{ id: string }> =>
    apiFetch<{ id: string }>('/shifts/open', {
      method: 'POST',
      body: JSON.stringify({ openingFloatCentavos }),
    }),

  closeShift: (
    shiftId: string,
    body: { countedCentavos: number; note?: string },
  ): Promise<{ id: string; closedAt: string }> =>
    apiFetch<{ id: string; closedAt: string }>(`/shifts/${shiftId}/close`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * The dashboard's attendance trend. Both bounds are inclusive gym-local
   * civil dates ('YYYY-MM-DD') — never an ISO instant, which the server
   * rejects by design.
   */
  checkInsDaily: (from: string, to: string): Promise<DailyCheckIns> =>
    apiFetch<DailyCheckIns>(`/admin/check-ins/daily${qs({ from, to })}`),

  /**
   * The gym's public settings. The sale screens read `vatRegistered` from it
   * so a statutory discount's total is shown before the sale, worked out the
   * way the server will work it out.
   */
  gymConfig: (): Promise<PublicGymConfig> => apiFetch<PublicGymConfig>('/config'),

  plans: (params: { includeInactive?: boolean } = {}): Promise<PaginatedData<AdminPlan>> =>
    apiFetch<PaginatedData<AdminPlan>>(`/admin/plans${qs({ limit: 50, ...params })}`),

  hours: (): Promise<DayHours[]> => apiFetch<DayHours[]>('/admin/hours'),

  replaceHours: (days: DayHours[]): Promise<DayHours[]> =>
    apiFetch<DayHours[]>('/admin/hours', { method: 'PUT', body: JSON.stringify({ days }) }),

  assistantSettings: (): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant'),

  saveAssistantInstructions: (instructions: string): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant', {
      method: 'PUT',
      body: JSON.stringify({ instructions }),
    }),

  resetAssistantInstructions: (): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant', { method: 'DELETE' }),

  /** Runs the UNSAVED draft. Spends the shared Gemini quota; 10 a minute. */
  tryAssistantDraft: (instructions: string, question: string): Promise<AssistantDraftAnswer> =>
    apiFetch<AssistantDraftAnswer>('/admin/assistant/test', {
      method: 'POST',
      body: JSON.stringify({ instructions, question }),
    }),

  // ── The gym's equipment list (Admin → Settings), fed to the AI planners ──
  equipment: (): Promise<GymEquipmentItem[]> => apiFetch<GymEquipmentItem[]>('/admin/equipment'),

  addEquipment: (input: GymEquipmentInput): Promise<GymEquipmentItem> =>
    apiFetch<GymEquipmentItem>('/admin/equipment', { method: 'POST', body: JSON.stringify(input) }),

  updateEquipment: (id: string, input: GymEquipmentInput): Promise<GymEquipmentItem> =>
    apiFetch<GymEquipmentItem>(`/admin/equipment/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  removeEquipment: (id: string): Promise<{ removed: true }> =>
    apiFetch<{ removed: true }>(`/admin/equipment/${id}`, { method: 'DELETE' }),

  /** Every id, in the new order. */
  reorderEquipment: (ids: string[]): Promise<GymEquipmentItem[]> =>
    apiFetch<GymEquipmentItem[]>('/admin/equipment/order', {
      method: 'PUT',
      body: JSON.stringify({ ids }),
    }),

  dailySummary: (date?: string): Promise<Record<string, unknown>> =>
    apiFetch<Record<string, unknown>>(
      `/reports/daily-summary${qs(date === undefined ? {} : { date })}`,
    ),

  revenue: (from: string, to: string, groupBy: RevenueGroup = 'month'): Promise<RevenueReport> =>
    apiFetch<RevenueReport>(`/reports/revenue${qs({ from, to, groupBy })}`),

  recurring: (): Promise<RecurringReport> => apiFetch<RecurringReport>('/reports/recurring'),

  /** `GET /reports/walk-ins` — volume, takings, peak hours and conversions. */
  walkInStats: (from: string, to: string): Promise<WalkInStatsReport> =>
    apiFetch<WalkInStatsReport>(`/reports/walk-ins${qs({ from, to })}`),

  /**
   * `GET /reports/memberships` — membership MOVEMENT in a window.
   *
   * Not `memberships({ from, to })`, and the distinction is the whole point:
   * `Membership.userId` is `@unique`, one row per member with renewals
   * mutating it, so a date filter over that table answers a historical
   * question with today's term. This reads the append-only MembershipEvent
   * log instead.
   */
  reportMemberships: (from: string, to: string): Promise<MembershipActivityReport> =>
    apiFetch<MembershipActivityReport>(`/reports/memberships${qs({ from, to })}`),

  leads: (status?: LeadStatus): Promise<Lead[]> =>
    apiFetch<Lead[]>(`/admin/leads${qs(status === undefined ? {} : { status })}`),

  updateLead: (
    id: string,
    patch: { status?: LeadStatus; assignedToId?: string | null; notes?: string },
  ): Promise<Lead> =>
    apiFetch<Lead>(`/admin/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  createPlan: (input: CreatePlanInput): Promise<AdminPlan> =>
    apiFetch<AdminPlan>('/admin/plans', { method: 'POST', body: JSON.stringify(input) }),

  updatePlan: (id: string, input: UpdatePlanInput): Promise<AdminPlan> =>
    apiFetch<AdminPlan>(`/admin/plans/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),

  /**
   * Archive, never delete — there is no delete route and there should not be.
   * A plan is named by every membership and payment ever sold on it; removing
   * the row would strand that history. Idempotent server-side.
   */
  archivePlan: (id: string): Promise<AdminPlan> =>
    apiFetch<AdminPlan>(`/admin/plans/${id}/archive`, { method: 'POST' }),

  /**
   * Coach assignments. `activeOnly` defaults to TRUE server-side, so a caller
   * that wants the history has to say so — which is the safer default for a
   * screen whose main question is "who coaches whom right now".
   */
  coachAssignments: (
    params: {
      page?: number;
      limit?: number;
      coachId?: string;
      memberId?: string;
      activeOnly?: boolean;
    } = {},
  ): Promise<PaginatedData<CoachAssignmentItem>> =>
    apiFetch<PaginatedData<CoachAssignmentItem>>(`/coach-assignments${qs(params)}`),

  /**
   * The audit trail. `audit.read`, ADMIN only.
   *
   * Read-only, and there is no write wrapper anywhere in this file on purpose:
   * entries are written by the actions themselves. A client that could author
   * an audit entry could author an alibi.
   */
  audit: (
    params: {
      page?: number;
      limit?: number;
      action?: string;
      actorId?: string;
      subjectId?: string;
    } = {},
  ): Promise<PaginatedData<AuditEntry>> =>
    apiFetch<PaginatedData<AuditEntry>>(`/admin/audit${qs(params)}`),

  /**
   * When recording started. The screen needs it to say "recorded from <date>"
   * rather than presenting a short list as a complete history forward-only
   * logging makes "nothing happened" and "nothing was recorded" identical
   * otherwise.
   */
  auditCoverage: (): Promise<{ recordingSince: string | null }> =>
    apiFetch(`/admin/audit/coverage`),

  /**
   * The system-notification board, one page at a time. `notification.read`.
   *
   * Archived (resolved) notices leave the inbox and live under `archived`, so
   * staff can still see that somebody handled one. The response is a plain
   * page of rows; the totals for the pager come from `notificationCounts`.
   */
  notifications: (
    params: {
      unreadOnly?: boolean;
      includeResolved?: boolean;
      archived?: boolean;
      /** Title or body, any case. */
      search?: string;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<SystemNotification[]> =>
    apiFetch<SystemNotification[]>(`/admin/notifications${qs(params)}`),

  /**
   * Counted server-side — a page's length is not a total. Narrowed by the same
   * `search` as the list, so each tab's number is what that tab shows.
   */
  notificationCounts: (
    search?: string,
  ): Promise<{ unread: number; unresolved: number; archived: number }> =>
    apiFetch(`/admin/notifications/counts${qs({ search })}`),

  markNotificationRead: (id: string): Promise<SystemNotification> =>
    apiFetch<SystemNotification>(`/admin/notifications/${id}/read`, { method: 'POST' }),

  /** Marks it read too, if nobody had. `notification.resolve`. */
  resolveNotification: (id: string): Promise<SystemNotification> =>
    apiFetch<SystemNotification>(`/admin/notifications/${id}/resolve`, { method: 'POST' }),

  /**
   * The Notifications panel's expiry alerts, ONE PAGE per request: ending
   * soon (soonest first), then lapsed (most recent first). `membership.read`.
   */
  membershipAlerts: (params: {
    page: number;
    limit: number;
    search?: string;
    archived?: boolean;
  }): Promise<PaginatedData<MembershipAlertItem>> =>
    apiFetch<PaginatedData<MembershipAlertItem>>(`/memberships/alerts${qs(params)}`),

  /** Archive this term's expiry alert; a renewal brings the next one back. */
  archiveExpiryAlert: (membershipId: string): Promise<{ archivedFor: string }> =>
    apiFetch(`/memberships/${membershipId}/expiry-alert/archive`, { method: 'POST' }),

  restoreExpiryAlert: (membershipId: string): Promise<{ restored: true }> =>
    apiFetch(`/memberships/${membershipId}/expiry-alert/restore`, { method: 'POST' }),

  /** Undo an archive. `notification.resolve`. */
  restoreNotification: (id: string): Promise<SystemNotification> =>
    apiFetch<SystemNotification>(`/admin/notifications/${id}/restore`, { method: 'POST' }),

  /**
   * Mark the whole unread column seen. There is deliberately no "resolve all"
   * counterpart — nobody rings back forty leads in one click.
   */
  markAllNotificationsRead: (): Promise<{ changed: number }> =>
    apiFetch(`/admin/notifications/read-all`, { method: 'POST', body: JSON.stringify({}) }),

  /**
   * Assign a coach to a member — `coach.assign`.
   *
   * REASSIGNMENT IS THIS SAME CALL. The server ends any incumbent assignment
   * and inserts the new one in one transaction, so there is no "unassign then
   * assign" dance for a client to get half-way through. A member has at most
   * one active coach and a unique sentinel in the database enforces it, so two
   * staff assigning at once cannot both win — the loser gets 409
   * MEMBER_ALREADY_ASSIGNED.
   */
  assignCoach: (body: {
    coachId: string;
    memberId: string;
    notes?: string;
  }): Promise<CoachAssignmentItem> =>
    apiFetch<CoachAssignmentItem>('/coach-assignments', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /**
   * End an assignment — `coach.update`. A soft end: the row stays, so "who
   * coached Juan last year" is still answerable. Idempotent, and it returns
   * the row rather than 204 so the screen can render "ended 18 Aug" from it.
   */
  endCoachAssignment: (id: string): Promise<CoachAssignmentItem> =>
    apiFetch<CoachAssignmentItem>(`/coach-assignments/${id}`, { method: 'DELETE' }),
};

/**
 * Integer centavos → `₱1,500`.
 *
 * THE SERVER NEVER SENDS A FORMATTED CURRENCY STRING — money is integer
 * centavos on the wire, everywhere, and every surface renders its own. That is
 * why this function lives on the client: a price baked into a server string
 * goes stale the day the owner changes it and ships in the next release
 * instead of the next request.
 */
export function peso(centavos: number, options: { decimals?: boolean } = {}): string {
  const value = centavos / 100;
  return `₱${value.toLocaleString('en-PH', {
    minimumFractionDigits: options.decimals === true ? 2 : 0,
    maximumFractionDigits: options.decimals === true ? 2 : 0,
  })}`;
}

/**
 * '2026-08-20' → '20 Aug 2026'. A CivilDate, formatted without a timezone.
 *
 * Re-exported from `gymTime` rather than implemented twice: the coach's portal
 * dashboard needs the same rendering, and the portal must not import this file
 * — `adminApi` is the console's surface and a coach never reaches the console.
 */
export { formatCivilDate as civilDate } from './gymTime';

/** An INSTANT, in the gym's own zone. Never used on a `@db.Date` value. */
export function gymTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Manila',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

export function gymDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Manila',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso));
}

/** '1 h 26 m'. Same shape the check-in verdict uses, so the two agree. */
export function duration(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  const hours = Math.floor(whole / 60);
  return hours === 0 ? `${whole} m` : `${hours} h ${whole % 60} m`;
}
