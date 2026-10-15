import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

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
  @IsString()
  @MaxLength(500)
  notes?: string;
}
