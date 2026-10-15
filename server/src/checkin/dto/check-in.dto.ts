import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { STATION_TOKEN_REGEX } from '@got/shared';

/**
 * The station check-in payload — `GOTS1.<stationCode>.<slot>.<mac>`, §6.1.1.
 *
 * This is the canonical DTO of this codebase: chunk 2 builds the check-in
 * module around it, and every other DTO copies its shape, comments included.
 * There is deliberately no controller wired to it yet.
 *
 * Note what is ABSENT, because it is as much of the pattern as the decorators
 * are. There is no `userId`: identity comes from the JWT, and a body that
 * could name a member would let any authenticated account check in anyone
 * else. There is no `occurredAt`: the instant comes from the server, because a
 * client-supplied one lets a phone backdate attendance (§6.5.1).
 *
 * Validating the shape here means a malformed scan is a 400 from the pipe and
 * never reaches the HMAC verifier, which should only ever see well-formed
 * input.
 */
export class CheckInDto {
  // Runs before validators: some in-browser QR decoders emit lowercase, and
  // the deferred kiosk / staff-scan mode (§6.13.2) uses keyboard-wedge
  // hardware that appends a newline. Normalising here is the difference
  // between "works on the desk hardware" and "works on my laptop".
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  // 36 with an eight-digit slot, 37 with nine. The regex is what actually
  // pins the field widths; this bounds the work the regex has to do.
  @Length(36, 37)
  @Matches(STATION_TOKEN_REGEX, {
    message: 'payload is not a Gym of Thrones station code',
  })
  stationToken!: string;
}
