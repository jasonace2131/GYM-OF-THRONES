import { IsEnum, IsOptional, IsString, IsUUID, Length, ValidateIf } from 'class-validator';
import { LeadStatus } from '@prisma/client';
import { TrimOrNull } from '../../common/validators/text.validators';

/**
 * Working a lead. Everything optional — the screen sends only what changed.
 *
 * `convertedAt` is absent by design: `Lead_converted_shape` ties it to the
 * status in both directions, so the service derives it. A client that could
 * send one would be able to produce a combination the database refuses, for a
 * rule it had no way to know about.
 */
export class UpdateLeadDto {
  @IsOptional()
  @IsEnum(LeadStatus)
  status?: LeadStatus;

  /** `null` unassigns — which is why this is not simply `@IsUUID()`. */
  @IsOptional()
  @ValidateIf((_dto: UpdateLeadDto, value: unknown) => value !== null)
  @IsUUID()
  assignedToId?: string | null;

  @IsOptional()
  @TrimOrNull()
  @IsString()
  @Length(1, 4000)
  notes?: string | null;
}
