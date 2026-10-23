import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { Trim } from '../../common/validators/text.validators';

/**
 * The first POST body DTO in this codebase.
 *
 * Required properties take the definite-assignment `!` because server
 * TypeScript is `strict` and the ValidationPipe — not the constructor — is
 * what guarantees they are present.
 */
export class CreateCoachAssignmentDto {
  @IsUUID('4')
  coachId!: string;

  @IsUUID('4')
  memberId!: string;

  @IsOptional()
  @Trim()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
