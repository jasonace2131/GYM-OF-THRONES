import { IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { IsCodePointLength } from '../../common/validators/is-code-point-length.validator';
import { ASSISTANT_INSTRUCTIONS_MAX_LENGTH } from '../assistant-prompt';

/**
 * Trimmed before validation, so whitespace alone is a 400 naming the field —
 * and so the length checked here is the length stored, in code points: what
 * Postgres `char_length` and the editor's counter count.
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SaveAssistantInstructionsDto {
  @Transform(trim)
  @IsString()
  @IsCodePointLength(1, ASSISTANT_INSTRUCTIONS_MAX_LENGTH)
  instructions!: string;
}

export class TryAssistantDraftDto {
  @Transform(trim)
  @IsString()
  @IsCodePointLength(1, ASSISTANT_INSTRUCTIONS_MAX_LENGTH)
  instructions!: string;

  /** The member assistant's own bound (AskAssistantDto). */
  @Transform(trim)
  @IsString()
  @IsCodePointLength(1, 2000)
  question!: string;
}
