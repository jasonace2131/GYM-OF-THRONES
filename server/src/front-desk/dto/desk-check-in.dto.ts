import { Transform, type TransformFnParams } from 'class-transformer';
import {
  IsBoolean,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import { CODE_CHAR_CLASS, MEMBER_CODE_LENGTH } from '@got/shared';
import { ExactlyOne } from '../../common/validators/exactly-one.validator';

/**
 * Route 45 — `POST /front-desk/check-ins`.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS A FIRST-CLASS PATH, NOT A FALLBACK, and the word "fallback" appears
 * nowhere staff can see.
 *
 * Per-visit self-scan failure — no smartphone, a dead battery, a phone in a
 * locker, no signal, logged out on a new handset, camera permission denied
 * months ago, a cracked screen, an old phone that cannot decode a glossy
 * panel — is realistically 15-30% of arrivals and worst at both peaks. A path
 * carrying a quarter of traffic at three times the transaction time has to be
 * designed as a main road.
 * ─────────────────────────────────────────────────────────────────────────
 */
@ExactlyOne(['userId', 'memberCode'], {
  message: 'Identify the member by exactly one of userId or memberCode',
})
export class CreateManualCheckInDto {
  /**
   * The member found by NAME in the console's search. Produces
   * `method = MANUAL`.
   */
  @IsOptional()
  @IsUUID('4')
  userId?: string;

  /**
   * The printed member code, TYPED. Produces `method = MEMBER_CODE`.
   *
   * The distinction is not cosmetic: a typed code proves the member had their
   * card, which is a weaker identity claim than a staffer recognising a face
   * but a stronger one than a name search — and the two are told apart in the
   * data precisely so a fraud review can distinguish them later.
   */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsOptional()
  @IsString()
  // The length lives in @got/shared, not as a literal here. Two copies of a
  // code width is how a six-character card and a five-character regex ship in
  // one release and reject every member who hands one over.
  @Matches(new RegExp(`^${CODE_CHAR_CLASS}{${MEMBER_CODE_LENGTH}}$`), {
    message: 'memberCode is not a Gym of Thrones member code',
  })
  memberCode?: string;

  /**
   * Required when the member has NO PHOTO on file.
   *
   * The photo is the desk's identity control on this path, and it is used more
   * often here than anywhere else in the system. When there is no photo the
   * operator is asserting recognition instead, and that assertion is made
   * explicitly rather than inferred from the absence of a column.
   */
  @IsOptional()
  @IsBoolean()
  identityConfirmed?: boolean;

  /**
   * The desk's OWN offline queue flushing (§6.10.4).
   *
   * Staff-attributed writes are exactly the kind a queue can safely carry: the
   * accountable party is a named operator, not a client-set boolean. THE
   * MEMBER HAS NO SUCH QUEUE and never will — a queued station token has
   * expired by the time it flushes, and honouring a stale one would widen the
   * relay window from a minute to the queue's TTL.
   *
   * Clamped server-side to `CHECKIN_OFFLINE_MAX_AGE_HOURS`, and never into the
   * future.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  occurredAt?: string;

  @IsOptional()
  @IsBoolean()
  offlineQueued?: boolean;
}

/** Route 46 — the rail's `⏻ CHECK OUT`. */
export class CheckOutDto {
  /**
   * Optional, and bounded the same way `occurredAt` is: the desk queue may be
   * flushing a close that happened while the network was down.
   */
  @IsOptional()
  @IsISO8601({ strict: true })
  endedAt?: string;
}

/**
 * Route 47 — voiding a visit.
 *
 * A void is a CORRECTION, not a delete: the row stays, `voidedAt` is stamped,
 * and every count that matters already filters on it. Deleting would remove
 * the evidence that a mistake was made, which is the one thing an audit trail
 * exists for.
 */
export class VoidCheckInDto {
  /**
   * A second, explicit yes. `isDangerous` keys get one because the action is
   * not reversible from the console and the row it touches is somebody's
   * attendance record.
   */
  @IsBoolean()
  confirm!: boolean;

  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 200)
  reason!: string;
}
