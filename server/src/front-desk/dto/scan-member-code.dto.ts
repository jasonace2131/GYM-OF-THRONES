import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';
import { CODE_CHAR_CLASS, MEMBER_CODE_LENGTH } from '@got/shared';

/**
 * The payload a member's phone renders and the desk scans.
 *
 * Shape-checked HERE, before the service ever computes an HMAC — the same
 * ordering the station token follows. A malformed string must be rejected by
 * the pipe rather than reaching crypto, so a scanner pointed at a soft-drink
 * barcode costs nothing.
 */
export class ScanMemberCodeDto {
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(64)
  @Matches(new RegExp(`^GOTM1\.${CODE_CHAR_CLASS}{${MEMBER_CODE_LENGTH}}\.\d{8,9}\.${CODE_CHAR_CLASS}{16}$`), {
    message: 'That is not a Gym of Thrones member code',
  })
  payload!: string;

  /**
   * Carried through to the same place route 45 puts it. A member with no photo
   * still needs the operator to assert recognition — a scanned code proves the
   * phone, not the face.
   */
  @IsOptional()
  @IsBoolean()
  identityConfirmed?: boolean;
}
