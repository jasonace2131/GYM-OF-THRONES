import {
  IsBoolean,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Bounds match the `ClassSession_*_sane` CHECKs exactly, so nothing the pipe
 * accepts can be rejected by the database.
 */
export class CreateClassSessionDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  title!: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 1000)
  description?: string;

  @IsUUID('4')
  coachId!: string;

  /** ISO instants. The gym-local day is DERIVED from `startsAt`, not sent. */
  @IsISO8601({ strict: true })
  startsAt!: string;

  @IsISO8601({ strict: true })
  endsAt!: string;

  /** 500 is a typo guard — larger than any room this gym has. */
  @IsInt()
  @Min(1)
  @Max(500)
  capacity!: number;
}

export class UpdateClassSessionDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 80)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 1000)
  description?: string;

  @IsOptional()
  @IsUUID('4')
  coachId?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  startsAt?: string;

  @IsOptional()
  @IsISO8601({ strict: true })
  endsAt?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  capacity?: number;
}

export class ListClassSessionsQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;

  @IsOptional()
  @IsUUID('4')
  coachId?: string;
}

/**
 * Cancelling needs a reason, and it is shown to every member who booked.
 *
 * "Cancelled" with no explanation is the message that makes somebody stop
 * booking classes altogether.
 */
export class CancelClassSessionDto {
  @Transform(trimmed)
  @IsString()
  @Length(3, 300)
  reason!: string;
}

export class MarkAttendanceDto {
  @IsBoolean()
  attended!: boolean;
}

/**
 * `POST /admin/class-sessions/:id/bookings` — the desk adding a member by hand.
 *
 * Only the member's id. Whether a place is free, the class has ended or the
 * account is a member at all is the service's question, asked under the lock
 * on the class; nothing in the body could answer it.
 */
export class AddMemberToClassDto {
  @IsUUID('4')
  userId!: string;
}

/**
 * `POST /admin/class-sessions/bookings/:bookingId/remove` — the desk taking a
 * member out of a class.
 *
 * The reason is REQUIRED and the member reads it in their notice, for the same
 * reason a class cancellation needs one: "you were removed" with no why is the
 * message that loses a member. 3–300 trimmed characters, the bounds of
 * `ClassBooking_removal_reason_shape`, so nothing the pipe accepts can be
 * refused by the database.
 */
export class RemoveFromClassDto {
  @Transform(trimmed)
  @IsString()
  @Length(3, 300)
  reason!: string;
}

/** `GET /me/bookings` — a window of gym days. Meaning is checked by resolveDateWindow. */
export class ListMyBookingsQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;
}
