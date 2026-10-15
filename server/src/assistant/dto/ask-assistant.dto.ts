import { IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform } from 'class-transformer';

export class AskAssistantDto {
  /**
   * Trimmed before validation, so a message of pure whitespace is a 400 naming
   * the field rather than passing the length check and failing at the
   * database's `AiMessage_content_sane` CHECK as a 500.
   *
   * 2000 characters is a generous question. The stored column allows 20000
   * because the assistant's own answer shares it.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 2000)
  message!: string;

  /**
   * Continues an existing conversation; absent starts a new one.
   *
   * Validated as a UUID here and re-checked against the caller's own id in the
   * service — a well-formed UUID belonging to somebody else must not resolve,
   * and the service's `findFirst({ id, userId })` is what enforces that.
   */
  @IsOptional()
  @IsUUID()
  conversationId?: string;
}
