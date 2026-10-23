import {
  IsBoolean,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * Bounds match `Announcement_title_sane` and `Announcement_content_sane` in the
 * migration exactly, so nothing the pipe accepts can be rejected by the
 * database. The DTO stops a bad request; the CHECK stops a bad INSERT from a
 * seed, a fix-up script, or a future service that forgets the DTO.
 *
 * TRIMMED BEFORE VALIDATION, and that ordering is the point: the CHECK measures
 * `char_length(btrim(...))`, so a title of three spaces passes `@Length(1, 120)`
 * on the raw string and then fails at the database as a 500. Trimming first
 * makes the two agree and turns it into a 400 that says which field.
 *
 * ONE BODY, TWO SPELLINGS. `contentJson` (ProseMirror JSON from the console's
 * rich editor) is the normal case; plain `content` is still accepted so every
 * existing caller and test keeps working. Exactly one is required — the
 * service refuses both, because for a rich notice `content` is DERIVED from the
 * JSON and a caller-supplied copy could only disagree with it. The JSON is
 * checked here only for being an object; the allowlist lives in
 * `rich-content.ts`, because it needs the configured bucket URL.
 */
const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateAnnouncementDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 120)
  title!: string;

  /** Required only when there is no `contentJson`. */
  @ValidateIf((dto: CreateAnnouncementDto) => dto.contentJson === undefined)
  @Transform(trimmed)
  @IsString()
  @Length(1, 4000)
  content?: string;

  /** A ProseMirror `doc`. `null` is refused: send `content` for a plain notice. */
  @ValidateIf((dto: CreateAnnouncementDto) => dto.contentJson !== undefined)
  @IsObject()
  contentJson?: Record<string, unknown>;

  /**
   * An image in the public announcements bucket. Its shape is checked in the
   * service, against the configured bucket URL.
   */
  @ValidateIf((dto: CreateAnnouncementDto) => dto.coverImageUrl != null)
  @IsString()
  @MaxLength(2048)
  // The shape here; WHICH host (our Supabase bucket only) is the service's
  // `resolveCover` check, which knows the configured storage URL.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  coverImageUrl?: string | null;

  /**
   * Optional, defaulting to false. Posting is the common case; pinning is a
   * deliberate act, and a default-pinned notice would put every announcement
   * at the top and make pinning meaningless.
   */
  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
