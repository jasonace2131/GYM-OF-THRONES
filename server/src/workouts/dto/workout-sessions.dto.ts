import { BadRequestException } from '@nestjs/common';
import { Allow, IsIn, IsInt, IsOptional, IsUUID, Max, Min, ValidateIf } from 'class-validator';
import {
  SESSION_LIMITS,
  WORKOUT_FEELINGS,
  WORKOUT_PLAN_LIMITS,
  type StartSessionBody,
  type WorkoutFeeling,
  type WorkoutSessionSource,
} from '@got/shared';

/**
 * The workout-session request bodies (feat/workout-sessions).
 *
 * The pipe proves TYPES and whitelists fields (the global ValidationPipe
 * rejects anything undeclared). The one RULE with a shared parser — a logged
 * set's weight and reps — is `parseLogSetBody` from @got/shared, the same
 * function the session screen runs, so `LogSetDto` only declares its two
 * fields and lets the values through untouched for the parser to judge.
 */

const SESSION_SOURCES: readonly WorkoutSessionSource[] = ['MEMBER_PLAN', 'COACH_PLAN'];

const isMemberPlan = (dto: StartSessionDto): boolean => dto.source === 'MEMBER_PLAN';
const isCoachPlan = (dto: StartSessionDto): boolean => dto.source === 'COACH_PLAN';

/** `StartSessionBody`: a member-plan day by weekday, or a coach-plan day by index. */
export class StartSessionDto {
  @IsIn(SESSION_SOURCES)
  source!: WorkoutSessionSource;

  @ValidateIf(isMemberPlan)
  @IsUUID()
  planId?: string;

  @ValidateIf(isMemberPlan)
  @IsInt()
  @Min(0)
  @Max(6)
  weekday?: number;

  @ValidateIf(isCoachPlan)
  @IsInt()
  @Min(0)
  @Max(WORKOUT_PLAN_LIMITS.daysMax - 1)
  dayIndex?: number;
}

/**
 * The validated DTO as the shared union. The other source's fields are
 * refused rather than ignored: a body naming both is a client bug worth
 * hearing about, not a guess worth making.
 */
export function startBodyOf(dto: StartSessionDto): StartSessionBody {
  if (dto.source === 'MEMBER_PLAN') {
    if (dto.dayIndex !== undefined) {
      throw new BadRequestException('dayIndex goes with source COACH_PLAN only.');
    }
    return { source: 'MEMBER_PLAN', planId: dto.planId!, weekday: dto.weekday! };
  }
  if (dto.planId !== undefined || dto.weekday !== undefined) {
    throw new BadRequestException('planId and weekday go with source MEMBER_PLAN only.');
  }
  return { source: 'COACH_PLAN', dayIndex: dto.dayIndex! };
}

/**
 * `LogSetBody`, declared for the whitelist and nothing more. Typed `unknown`
 * on purpose: implicit conversion leaves an `Object`-typed property alone, so
 * "20" reaches `parseLogSetBody` as a string and is refused there with
 * WORKOUT_SET_INVALID and the parser's words, not coerced into a number.
 */
export class LogSetDto {
  @Allow()
  weightKg?: unknown;

  @Allow()
  reps?: unknown;
}

/** `FinishSessionBody`. */
export class FinishSessionDto {
  @IsOptional()
  @IsIn(WORKOUT_FEELINGS)
  feeling?: WorkoutFeeling;
}

/** `PatchSessionBody` — a feeling, or an explicit null to clear it. */
export class PatchSessionDto {
  @ValidateIf((dto: PatchSessionDto) => dto.feeling !== null)
  @IsIn(WORKOUT_FEELINGS)
  feeling!: WorkoutFeeling | null;
}

/** `GET /me/workouts/sessions?limit=`. */
export class ListSessionsQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(SESSION_LIMITS.historyPageMax)
  limit?: number;
}
