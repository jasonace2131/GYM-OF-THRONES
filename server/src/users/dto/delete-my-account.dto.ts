import { Equals, IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * `POST /me/delete-account` — the member's own, instant, anonymising delete.
 *
 * `confirm: true` is a literal, not a flag: a body without it is a 400, so no
 * client bug that posts `{}` can delete an account. `password` is checked
 * against Supabase on the server before anything changes. Never trimmed — a
 * password is exactly what was typed.
 */
export class DeleteMyAccountDto {
  // The RAW body value: implicit conversion would turn the string "false"
  // into `true`, which must never confirm a deletion.
  @Transform(({ obj }: { obj: Record<string, unknown> }) => obj['confirm'])
  @Equals(true, { message: 'confirm must be true' })
  confirm!: true;

  @IsString()
  @Length(1, 200)
  password!: string;
}
