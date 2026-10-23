import { Transform, type TransformFnParams } from 'class-transformer';
import { IsEmail, IsOptional, IsString, Length, ValidateIf } from 'class-validator';
import { IsPersonName, IsPhPhone } from '../../common/validators/text.validators';

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The public contact form.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY DTO IN THIS CODEBASE AN ANONYMOUS STRANGER CAN REACH.
 *
 * Every other write route sits behind AuthGuard → UserThrottlerGuard →
 * PermissionsGuard. This one has only the throttler and this class, so the
 * validation here is the security boundary rather than a convenience.
 *
 * `forbidNonWhitelisted` is on globally, so any property not declared below
 * is a 400 — which is also what makes the honeypot work: a bot filling every
 * input it can see submits `website`, and `website` is declared precisely so
 * it can be inspected rather than rejected as unknown.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class SubmitLeadDto {
  @IsPersonName('name')
  name!: string;

  /**
   * Email OR phone — at least one, enforced by `Lead_contactable` in SQL and
   * by the pair of `ValidateIf`s below so the caller gets a readable message
   * rather than a constraint violation.
   */
  // Without a usable phone the email is REQUIRED (Lead_contact CHECK: one of
  // the two must be present) — no @IsOptional, or a body with neither 500s.
  @ValidateIf(
    (dto: SubmitLeadDto) => !dto.phone || (dto.email !== undefined && dto.email !== null),
  )
  @Transform(trimmed)
  @IsEmail({}, { message: 'That email address does not look right.' })
  @Length(5, 254)
  email?: string;

  @ValidateIf((dto: SubmitLeadDto) => !dto.email || dto.phone !== undefined)
  @IsOptional()
  @IsPhPhone()
  phone?: string | null;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 2000)
  message?: string;

  /**
   * THE HONEYPOT. Hidden from people by CSS, filled in by bots that parse the
   * raw HTML and complete every input they find.
   *
   * Named `website` rather than `honeypot` for the obvious reason. Checked on
   * the SERVER, never in the browser — a client-side check is one the bot
   * skips by posting directly, which is what most of them do anyway.
   *
   * It is not sufficient on its own: a headless browser executing JS will
   * leave it empty. It is cheap, it costs a real user nothing, and for a
   * gym's contact form the combination of this and a 3/minute rate limit is
   * proportionate. A CAPTCHA nobody maintains is worse than either.
   */
  @IsOptional()
  @IsString()
  @Length(0, 200)
  website?: string;
}
