import { IsString, Length, Matches } from 'class-validator';

/**
 * The setup-link secret as it arrives from the email: 43 base64url characters
 * today. Loose bounds on purpose, like `StaffInvitationTokenDto` — a malformed
 * token should read "not a valid link" (404), not a validation error.
 */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]+$/;

/** Query of `GET /member-join/lookup`, body of `claim-link`. */
export class MemberJoinTokenDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;
}

/**
 * Body of `POST /member-join/accept`. The password never comes here — the page
 * sets it with Supabase directly, before calling this.
 *
 * `dateOfBirth` is a `yyyy-mm-dd` civil date from a date input. The SHAPE is
 * checked here; whether it is joinable is `asJoinableBirthDate`'s call in the
 * service, the same rule self sign-up uses.
 */
export class AcceptMemberJoinDto {
  @IsString()
  @Length(16, 128)
  @Matches(TOKEN_SHAPE)
  token!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;
}
