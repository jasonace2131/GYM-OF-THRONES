// Standard API response shapes — used by the server to respond
// and by the client to type-check responses.

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

export interface PaginatedData<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Every expected, named failure the client is meant to branch on.
 *
 * The server throws these through DomainException (422 by default) and
 * HttpExceptionFilter renders them into `error.code`. A generic HttpException
 * still reports `HTTP_<status>`, so adopting a code is opt-in per throw site.
 *
 * This union is closed: a failure with no code here is either an unmapped bug
 * (500) or needs the union widened in the same commit that throws it.
 */
export type DomainErrorCode =
  | 'STATION_TOKEN_MALFORMED'
  | 'STATION_TOKEN_INVALID'
  // The member-held fallback code (`GOTM1.…`), scanned by staff at the desk.
  // EXPIRED is kept distinct from INVALID because "hold it up again" is a
  // genuinely different instruction from "that is not a valid code" — every
  // other failure collapses into INVALID so the scanner cannot be used as an
  // oracle for which six-character member codes exist.
  | 'MEMBER_CODE_INVALID'
  | 'MEMBER_CODE_EXPIRED'
  | 'MEMBER_CODE_NOT_ISSUED'

  // ── Classes and bookings ─────────────────────────────────────────────
  // A FULL CLASS IS NOT AN ERROR while its waitlist is open: being waitlisted
  // is a successful outcome the member is told about in the response body,
  // the same rule the door follows when it denies somebody. Only once the
  // waitlist has closed does "full" become a refusal — WAITLIST_CLOSED below.
  | 'CLASS_NOT_FOUND'
  | 'CLASS_CANCELLED'
  | 'CLASS_ALREADY_CANCELLED'
  | 'CLASS_ALREADY_STARTED'
  | 'CLASS_ENDS_BEFORE_START'
  | 'CAPACITY_BELOW_BOOKED'
  | 'COACH_NOT_FOUND'
  | 'NOT_A_COACH'
  | 'ALREADY_BOOKED'
  | 'BOOKING_NOT_FOUND'
  | 'BOOKING_CANCELLED'
  // 422. The member's plan does not cover the day of the class (owner,
  // 2026-10-11: active ON THE CLASS DAY; grace days and day passes do not
  // count). Refused before any seat or waitlist place is taken. The message is
  // `bookingRefusalCopy` — member copy, never the desk's verdict — and
  // `details` is BookingPlanRequiredDetails (`{ reason, relevantDate }`).
  | 'BOOKING_PLAN_REQUIRED'
  // 422. The class is further ahead than this member may book
  // (CLASS_BOOKING_WINDOW_DAYS, or the priority window). The message names the
  // day booking opens; `details` is BookingWindowNotOpenDetails (`{ opensOn }`,
  // yyyy-mm-dd).
  | 'BOOKING_WINDOW_NOT_OPEN'
  // 422. The class is full and its waitlist has closed
  // (CLASS_WAITLIST_CLOSES_MINUTES_BEFORE). Worded per audience: a member is
  // told the waitlist has closed; the desk is told to raise the places.
  | 'WAITLIST_CLOSED'
  // 422. The class has ended: it can no longer be edited, and nobody can be
  // added to it. Distinct from CLASS_ALREADY_STARTED, because the desk may
  // still add a walk-in to a class that is running.
  | 'CLASS_FINISHED'
  // 422. A staff add named an account that cannot hold a class booking: it
  // does not exist, is deleted, or is not a member (CLIENT) — staff are not
  // members here (2026-09-25). One code for all three, because the desk's next
  // step is the same for each: pick a member from the roster.
  | 'MEMBER_NOT_BOOKABLE'
  | 'STATION_TOKEN_NOT_YET_VALID'
  | 'STATION_NOT_FOUND'
  | 'STATION_INACTIVE'
  | 'STATION_AMBIGUOUS'
  | 'STATION_BATCH_STALE'
  | 'GYM_CLOSED'
  | 'MEMBERSHIP_NOT_FOUND'
  | 'MEMBERSHIP_NOT_ACTIVE'
  | 'MEMBERSHIP_ALREADY_FROZEN'
  | 'MEMBERSHIP_NOT_FROZEN'
  | 'MEMBERSHIP_ALREADY_CANCELLED'
  | 'MEMBERSHIP_INVALID_TRANSITION'
  | 'MEMBERSHIP_FREEZE_LIMIT'
  | 'MEMBERSHIP_STATE_INVALID'
  | 'MEMBER_HAS_NO_MEMBERSHIP'
  | 'MEMBER_NOT_FOUND'
  | 'MEMBER_ALREADY_IMPORTED'
  | 'PLAN_NOT_FOUND'
  | 'PLAN_ARCHIVED'
  | 'PLAN_NOT_FREEZABLE'
  | 'FREEZE_ALREADY_USED_THIS_TERM'
  | 'FREEZE_WINDOW_INVALID'
  | 'PAYMENT_NOT_FOUND'
  | 'PAYMENT_ALREADY_VOIDED'
  | 'PAYMENT_AMOUNT_MISMATCH'
  | 'PAYMENT_SHAPE_INVALID'
  // An amend voids the original and writes a corrected replacement in its
  // place. A row may be superseded at most once (Payment_replacesPaymentId_key
  // makes the chain a linked list), so a second amend of the same original is
  // a refusal the console must see rather than a silently ignored write.
  | 'PAYMENT_ALREADY_AMENDED'
  // Only a WALK_IN payment has a nullable payer. Moving a MEMBERSHIP or
  // FREEZE_FEE payment to a different member would detach it from the term it
  // paid for, which Payment_purpose_shape forbids anyway.
  | 'PAYMENT_PAYER_IMMUTABLE'
  // Archive is a SOFT DELETE — it hides a row from the register and changes no
  // figure anywhere. The pair below are its guarded-update refusals.
  | 'PAYMENT_ALREADY_ARCHIVED'
  | 'PAYMENT_NOT_ARCHIVED'
  | 'GCASH_REFERENCE_REQUIRED'
  // A live GCash payment already carries this reference. Not folded into
  // PAYMENT_SHAPE_INVALID: the desk must tell "I already rang this one"
  // apart from "this member is showing me a recycled receipt".
  | 'GCASH_REFERENCE_DUPLICATE'
  // Above GCASH_VERIFY_THRESHOLD_CENTAVOS, staff must confirm they saw the
  // transaction in the gym's own GCash app before the sale saves.
  | 'GCASH_VERIFICATION_REQUIRED'
  | 'DISCOUNT_ID_REQUIRED'
  | 'STATUTORY_ID_REQUIRED'
  | 'CONFIRMATION_REQUIRED'
  | 'CHECKIN_NOT_FOUND'
  | 'CHECKIN_ALREADY_CLOSED'
  | 'CHECKIN_ALREADY_OPEN'
  // A visit that was already voided, and a desk-queued entry whose instant
  // falls outside CHECKIN_OFFLINE_MAX_AGE_HOURS or lands in the future.
  | 'CHECKIN_ALREADY_VOIDED'
  | 'CHECKIN_OCCURRED_AT_OUT_OF_RANGE'
  // The desk's sales funnel: a denial that no longer exists, or one a manager
  // already resolved by override — a different commercial outcome from a sale,
  // so the two are never silently conflated.
  | 'DENIAL_NOT_FOUND'
  | 'DENIAL_ALREADY_RESOLVED'
  // A host member with no guest passes left this term.
  | 'GUEST_PASS_EXHAUSTED'
  // A walk-in or guest-pass entry for somebody with no account, who has
  // therefore never met the portal's consent gate. The one person in the
  // building with no record of having been warned about anything.
  | 'GUEST_WAIVER_REQUIRED'
  // The "Make member" hand-off asked for guest contact on a row that is not
  // a guest visit (or does not exist). One code for both, deliberately: the
  // route must not be an oracle for which check-in ids belong to members.
  | 'GUEST_NOT_FOUND'
  // An account-less walk-in or guest-pass sale with no name, or no email. The
  // email is what lets "Make member" arrive pre-filled — the setup link goes there.
  | 'GUEST_NAME_REQUIRED'
  | 'GUEST_EMAIL_REQUIRED'
  // Promo codes. Distinct rather than one PROMOTION_INVALID, because the
  // counter says something different to the member for each: "never heard of
  // it", "not until Monday", "that ended", "all gone", "not on that plan".
  | 'PROMOTION_NOT_FOUND'
  | 'PROMOTION_NOT_STARTED'
  | 'PROMOTION_EXPIRED'
  | 'PROMOTION_EXHAUSTED'
  | 'PROMOTION_NOT_APPLICABLE'
  | 'CHECKIN_INVALID_SHAPE'
  | 'HOLD_OVERLAPS'
  | 'HOLD_LIMIT_EXCEEDED'
  | 'SHIFT_NOT_OPEN'
  | 'SHIFT_ALREADY_OPEN'
  | 'SHIFT_ALREADY_CLOSED'
  | 'SHIFT_VARIANCE_REASON_REQUIRED'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'COACH_ASSIGNMENT_NOT_FOUND'
  | 'COACH_NOT_A_COACH'
  | 'COACH_SELF_ASSIGNMENT'
  | 'MEMBER_ALREADY_ASSIGNED'
  /**
   * A date-ranged report was asked for a window that is inverted or wider than
   * the endpoint's cap. Named rather than left as a bare HTTP_400 because the
   * only sane client response is to narrow the range and retry, and a generic
   * validation failure gives a chart no way to say that.
   */
  | 'REPORT_RANGE_INVALID'

  // ── C1 — member write routes ────────────────────────────────────────────
  | 'MEMBER_ALREADY_SUSPENDED'
  | 'MEMBER_NOT_SUSPENDED'
  // Mirrors COACH_SELF_ASSIGNMENT's naming: the actor named in the route and
  // the actor making the call are the same person, and that is the whole
  // failure.
  | 'ROLE_SELF_CHANGE'
  // The same self-guard as ROLE_SELF_CHANGE, applied to the three other
  // routes that can lock an operator out of their own console: nobody may
  // suspend, reactivate or delete themselves. One code per route rather than
  // a shared MEMBER_SELF_ACTION, so the console can word each refusal.
  | 'MEMBER_SELF_SUSPEND'
  | 'MEMBER_SELF_REACTIVATE'
  | 'MEMBER_SELF_DELETE'
  // DEV is a seed/DB-only role (enums.prisma): no DTO can assign it and no
  // HTTP route may strip it, suspend it or delete the account holding it.
  | 'MEMBER_DEV_PROTECTED'
  // Suspension is a transition out of ACTIVE only. A DEACTIVATED account is
  // not "suspendable": letting it through would make suspend→reactivate a
  // two-call laundry cycle that washes DEACTIVATED to ACTIVE.
  | 'MEMBER_NOT_ACTIVE'
  // `POST /members/:id/restore` against a member who was never soft-deleted.
  | 'MEMBER_NOT_DELETED'

  // ── Staff & Access: the role hierarchy (shared/src/rbac/role-hierarchy.ts) ─
  // 403. The account's current role is not below the caller's — an ADMIN
  // acting on another ADMIN. Only the Super Admin (DEV) manages admins.
  | 'ROLE_TARGET_OUTRANKS'
  // 403. The NEW role is not below the caller's — an ADMIN promoting to ADMIN
  // — or it is DEV, which is never assignable.
  | 'ROLE_NOT_ASSIGNABLE'
  // 409. It would leave the gym with no active ADMIN.
  | 'LAST_ADMIN_PROTECTED'
  // Staff invitations. NOT_FOUND is 404 (an unknown token); EXPIRED, REVOKED
  // and USED are 410 — the link existed and is dead, and the invite page says
  // which. EMAIL_MISMATCH is 403: signed in as somebody else. PENDING (409)
  // is a second open invitation for the same address. ALREADY_HAS_ROLE and
  // WOULD_DEMOTE (409) mirror `inviteRefusal`. DISABLED is 503: no
  // SUPABASE_SERVICE_KEY, same warn-and-disable as member creation.
  | 'STAFF_INVITE_NOT_FOUND'
  | 'STAFF_INVITE_EXPIRED'
  | 'STAFF_INVITE_REVOKED'
  | 'STAFF_INVITE_USED'
  | 'STAFF_INVITE_EMAIL_MISMATCH'
  | 'STAFF_INVITE_PENDING'
  | 'STAFF_INVITE_ALREADY_HAS_ROLE'
  | 'STAFF_INVITE_WOULD_DEMOTE'
  | 'STAFF_INVITE_DISABLED'
  // 404. The account named is not a live coach — one code whether it does
  // not exist or holds another role, so the route is no oracle for either.
  | 'COACH_NOT_FOUND'
  // ── end Staff & Access ────────────────────────────────────────────────────

  // ── C2 — member creation with a magic link ──────────────────────────────
  // Either a local User row or a Supabase Auth user already exists for the
  // email — surfaced the same way regardless of which side found it first.
  | 'MEMBER_EMAIL_TAKEN'
  // Converting an enquiry: the leadId points at nothing, or at a lead already
  // linked to a member — one enquiry converts to one account, once.
  | 'LEAD_NOT_FOUND'
  | 'LEAD_ALREADY_CONVERTED'
  // SUPABASE_SERVICE_KEY is unset. Same warn-and-disable spirit as the AI
  // assistant's GEMINI_API_KEY: the gym must still boot without it, and this
  // one route refuses with a clear 503 instead of crashing at startup.
  | 'MEMBER_CREATE_DISABLED'
  // The Supabase admin API rejected generateLink for a reason OTHER than
  // "already registered" — a genuine upstream failure, not caller error.
  | 'MEMBER_INVITE_FAILED'
  // ── Counter sign-up — the member's own setup link ──────────────────────────
  // NOT_FOUND 404: no such link, or its member was deleted. EXPIRED and USED are
  // 410 — the link existed and is dead, and the setup page says which.
  // WRONG_ACCOUNT 403: accept called by a different signed-in account.
  // ALREADY_SIGNED_IN 409: resend or change-email for a member who has signed in
  // at least once — a link is a way into the account, so staff never get to mint
  // one for an active member. They use "Forgot password" instead.
  | 'MEMBER_JOIN_NOT_FOUND'
  | 'MEMBER_JOIN_EXPIRED'
  | 'MEMBER_JOIN_USED'
  | 'MEMBER_JOIN_WRONG_ACCOUNT'
  | 'MEMBER_ALREADY_SIGNED_IN'
  // 409 — resend or change-email for a staff account; staff accounts are set up from Staff & Access.
  | 'MEMBER_JOIN_STAFF_ACCOUNT'
  // ── GCash proof screenshots and the member's own payment claim ──
  //
  // The image is a PAPER TRAIL, never verification: a reference absent from the
  // gym's own Transactions tab is not a payment however good the picture looks.
  | 'PROOF_TYPE_UNSUPPORTED'
  | 'PROOF_UPLOAD_UNAVAILABLE'
  // Storage is unconfigured. Warn-and-disable, like member creation without
  // SUPABASE_SERVICE_KEY — the gym still boots and still sells memberships.
  | 'PROOF_UPLOAD_DISABLED'
  | 'GCASH_SUBMISSION_NOT_FOUND'
  // Two operators reviewing the same claim; the loser is told so plainly.
  | 'GCASH_SUBMISSION_ALREADY_REVIEWED'
  // The member already sent this reference and it is still being checked.
  | 'GCASH_SUBMISSION_PENDING'
  // Approving is the LINK, not the sale. Staff record the payment first, and
  // this says so rather than quietly minting money from a member's claim.
  | 'GCASH_PAYMENT_NOT_RECORDED'
  // A system notification the console tried to mark read or resolved is gone.
  // Reachable in normal use: the board polls, and two staff clearing the same
  // notice is exactly the race this names rather than 500s on.
  | 'NOTIFICATION_NOT_FOUND'

  // ── Rich-text announcements ─────────────────────────────────────────────
  // 400. The body or cover image broke the allowlist — an unknown node or
  // mark, a link that is not http/https/mailto, an image from outside the
  // announcements bucket, nesting too deep, or no text at all. The message
  // names which, and the composer shows it as-is.
  | 'ANNOUNCEMENT_CONTENT_INVALID'
  // 503. SUPABASE_SERVICE_KEY is unset: images are warn-and-disabled, like
  // PROOF_UPLOAD_DISABLED. Posting text still works.
  | 'ANNOUNCEMENT_UPLOAD_DISABLED'
  // 503. Storage refused to sign the upload — try the image again later.
  | 'ANNOUNCEMENT_UPLOAD_UNAVAILABLE'

  // ── Member workout planner (feat/member-workouts) ─────────────────────────
  // 429. Today's 8 AI actions are spent; the message says when they reset.
  | 'WORKOUT_AI_LIMIT'
  // 409. A generation is already running for this member.
  | 'WORKOUT_DRAFT_RUNNING'
  // 409. Save asked for a draft that is still RUNNING or has FAILED.
  | 'WORKOUT_DRAFT_NOT_READY'
  // 404. There is no draft to read, save or discard.
  | 'WORKOUT_DRAFT_MISSING'
  // 409. Five plans are kept already — delete one first.
  | 'WORKOUT_PLAN_LIMIT'
  // 400. A hand-edited body broke `parseMemberPlan`; `details.errors` lists why.
  | 'WORKOUT_PLAN_INVALID'
  // 404. A How-to was asked for an exercise in none of the caller's plans.
  | 'WORKOUT_EXERCISE_UNKNOWN'
  // 400. The intake was sent without `consent: true`.
  | 'WORKOUT_CONSENT_REQUIRED'
  // ── Workout sessions (feat/workout-sessions) ────────────────────────────
  // 409. A workout is already open — finish or discard it first. `details.sessionId` names it.
  | 'WORKOUT_SESSION_OPEN'
  // 404. No such session of the caller's.
  | 'WORKOUT_SESSION_MISSING'
  // 409. The session is finished; its sets can no longer change.
  | 'WORKOUT_SESSION_FINISHED'
  // 422. Finishing needs at least one ticked set — or discard the workout.
  | 'WORKOUT_SESSION_EMPTY'
  // 404. The plan has no such day (weekday or index), or the coach has no plan.
  | 'WORKOUT_DAY_UNKNOWN'
  // 400. A logged set broke `parseLogSetBody`, or its exercise/set index is out of range.
  | 'WORKOUT_SET_INVALID'

  // ── Class register and cancellation timing ──────────────────────────────
  // The register opens CLASS_REGISTER_OPENS_MINUTES_BEFORE a class starts;
  // marking earlier is refused rather than trusted.
  | 'CLASS_NOT_STARTED'
  // A waitlisted member has no seat, so there is nothing to mark present.
  | 'BOOKING_NOT_CONFIRMED'
  // Once the register has marked a booking, it is history, not a reservation.
  | 'BOOKING_NOT_CANCELLABLE'
  // A from/to window that is reversed, too wide, or not a real calendar date.
  | 'DATE_RANGE_INVALID'

  // ── The member assistant (all three are 503) ────────────────────────────
  // Named rather than left as a bare HTTP_503 because the portal says a
  // different thing for each, and the server's message is the one to show:
  //   NOT_CONFIGURED — GEMINI_API_KEY is unset (warn-and-disable, like
  //                    MEMBER_CREATE_DISABLED); asking again will not help.
  //   BUSY           — every model was rate-limited, unreachable or down.
  //   TIMEOUT        — the answer ran out of the server's time budget, which
  //                    a shorter request usually fits inside.
  | 'ASSISTANT_NOT_CONFIGURED'
  | 'ASSISTANT_BUSY'
  | 'ASSISTANT_TIMEOUT'
  // ── Coach-recorded progress ─────────────────────────────────────────────
  // 403 on the member's own progress write routes: the assigned coach records
  // progress now, and the member's copy says where to go for a coach.
  | 'PROGRESS_RECORDED_BY_COACH'
  // 409. A row the member recorded themselves is read-only — a coach may
  // delete it, never edit it or write over its day.
  | 'PROGRESS_SELF_RECORDED'
  // 422. A measurement with a date and no reading is not a measurement.
  | 'MEASUREMENT_EMPTY'
  // 422. A goal whose target equals its start has no progress to show.
  | 'GOAL_TARGET_EQUALS_START'

  // ── Coach tools (feat/coach-tools): chat and workout plans ──────────────
  // 403. Owner decision: no 1:1 coach chat for a member under 18 by date of
  // birth. They go through the front desk. (A NULL date of birth is allowed.)
  | 'CHAT_MINOR'
  // 409. The pair's assignment has ended: the thread is read-only history.
  | 'CHAT_READ_ONLY'
  // 409. A sender may withdraw their own message only within ten minutes.
  | 'CHAT_DELETE_WINDOW_PASSED'
  // 422. A saved plan failed the workout-plan schema (@got/shared).
  | 'WORKOUT_PLAN_INVALID'
  // 502. The model answered, but not with a plan the schema accepts.
  | 'WORKOUT_PLAN_SUGGESTION_INVALID';
