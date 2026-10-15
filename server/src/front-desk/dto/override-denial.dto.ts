import { Equals, IsString, Length } from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';

/**
 * Route 48 — admitting somebody the door turned away.
 *
 * `checkin.override` is the only permission in the catalogue marked dangerous,
 * and this DTO is where that shows up in the request itself.
 *
 * THE REASON IS MANDATORY AND FREE TEXT, not a dropdown. A dropdown of
 * override reasons becomes a list of excuses staff learn to click through, and
 * the fourth option is always "other". A typed sentence is the thing an owner
 * can actually read back in a month, and typing it is a real speed bump — a
 * deliberate one, since this is the control that lets a member in without
 * paying.
 */
export class OverrideDenialDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(6, 500, {
    message: 'Say why you are letting them in — a few words is enough, but not none',
  })
  reason!: string;

  /**
   * Must be literally `true`.
   *
   * The console asks a second time before sending, and this is the server
   * refusing to accept an override that did not go through that ask. A missing
   * field is a 400 rather than a silently-permitted admission.
   */
  @Equals(true, { message: 'CONFIRMATION_REQUIRED' })
  confirm!: boolean;
}
