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
 * Every field optional, bounds identical to `CreateAnnouncementDto`.
 *
 * Hand-written rather than `PartialType`, matching `UpdatePlanDto` and keeping
 * `@nestjs/mapped-types` out of the dependency list for one class. The cost is
 * that the two files must be kept in step — which is why the bounds are stated
 * here in full rather than implied.
 *
 * The global pipe runs `forbidNonWhitelisted`, so an unknown key is a 400 and
 * an empty body is a valid no-op.
 *
 * The body: `contentJson` replaces it with a rich document (and re-derives the
 * plain `content`); plain `content` replaces it with text and clears any JSON.
 * Sending both is refused in the service. `coverImageUrl: null` removes the
 * cover; leaving it out leaves the cover alone.
 */
const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class UpdateAnnouncementDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 120)
  title?: string;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, 4000)
  content?: string;

  @ValidateIf((dto: UpdateAnnouncementDto) => dto.contentJson !== undefined)
  @IsObject()
  contentJson?: Record<string, unknown>;

  @ValidateIf((dto: UpdateAnnouncementDto) => dto.coverImageUrl != null)
  @IsString()
  @MaxLength(2048)
  // The shape here; WHICH host (our Supabase bucket only) is the service's
  // `resolveCover` check, which knows the configured storage URL.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  coverImageUrl?: string | null;

  @IsOptional()
  @IsBoolean()
  isPinned?: boolean;
}
