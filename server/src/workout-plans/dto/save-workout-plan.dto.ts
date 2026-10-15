import { IsArray, IsDefined } from 'class-validator';

/**
 * The coach's plan, as the editor sends it: `{ summary, days }`.
 *
 * Deliberately loose at the pipe: the global ValidationPipe only proves both
 * fields are there (and rejects any other top-level field). The real schema —
 * every day, every exercise, every bound — is `parseWorkoutPlan` from
 * @got/shared, the same function the model's reply and the coach's editor go
 * through, and its per-field errors come back in the 422's `details`.
 */
export class SaveWorkoutPlanDto {
  @IsDefined()
  summary!: unknown;

  @IsArray()
  days!: unknown[];
}
