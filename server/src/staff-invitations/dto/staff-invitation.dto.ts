import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';
import { INVITABLE_ROLES, type InvitableRole } from '@got/shared';

/**
 * `POST /staff-invitations`. The role is one of FRONT_DESK, COACH or ADMIN
 * here; WHICH of those this caller may give is the role hierarchy's call in
 * the service, not the DTO's.
 *
 * The address is trimmed and lowercased on the way in, because the database
 * refuses anything else (`StaffInvitation_email_normalised`) and "Ana@" and
 * "ana@" must be one invitation.
 */
export class CreateStaffInvitationDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsIn(INVITABLE_ROLES)
  role!: InvitableRole;
}

/**
 * The invitation secret as it arrives from the link: 43 base64url
 * characters today. The bounds are loose on purpose — a malformed token
 * should read "not a valid link" (404 from the lookup), not a validation
 * error — but tight enough that nobody posts a novel into a hash function.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/** Body of `claim-link` and `accept`. */
export class StaffInvitationTokenDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;
}

/** Query of `GET /staff-invitations/lookup`. */
export class StaffInvitationLookupQueryDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;
}
