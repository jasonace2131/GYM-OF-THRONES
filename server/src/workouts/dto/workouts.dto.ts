import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  WORKOUT_ADJUST_PRESETS,
  WORKOUT_EASY_ON,
  WORKOUT_EXPERIENCE,
  WORKOUT_GOALS,
  WORKOUT_LIMITS,
  WORKOUT_SESSION_MINUTES,
  WORKOUT_TIMES_OF_DAY,
  type WorkoutAdjustPreset,
  type WorkoutEasyOn,
  type WorkoutExperience,
  type WorkoutGoal,
  type WorkoutSessionMinutes,
  type WorkoutTimeOfDay,
} from '@got/shared';

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * The member workout planner's request bodies (feat/member-workouts).
 *
 * The pipe proves TYPES and whitelists fields (the global ValidationPipe
 * rejects anything undeclared). The RULES — unique weekdays, the consent
 * literal, the plan schema — are `parseWorkoutIntake` and `parseMemberPlan`
 * from @got/shared, the same functions the wizard and the editor run, so
 * both sides cannot disagree.
 */

export class UseFactsDto {
  @IsBoolean()
  measurements!: boolean;

  @IsBoolean()
  attendance!: boolean;

  @IsBoolean()
  bookings!: boolean;
}

export class CreateDraftDto {
  @IsIn(WORKOUT_GOALS)
  goal!: WorkoutGoal;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @MaxLength(WORKOUT_LIMITS.goalNotesMax)
  goalNotes?: string;

  @IsIn(WORKOUT_EXPERIENCE)
  experience!: WorkoutExperience;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays!: number[];

  @IsIn(WORKOUT_SESSION_MINUTES)
  sessionMinutes!: WorkoutSessionMinutes;

  @IsIn(WORKOUT_TIMES_OF_DAY)
  timeOfDay!: WorkoutTimeOfDay;

  @IsBoolean()
  healthFlag!: boolean;

  @IsArray()
  @ArrayMaxSize(WORKOUT_EASY_ON.length)
  @IsIn(WORKOUT_EASY_ON, { each: true })
  easyOn!: WorkoutEasyOn[];

  @ValidateNested()
  @Type(() => UseFactsDto)
  use!: UseFactsDto;

  /**
   * Optional AT THE PIPE on purpose: a member who did not tick the box must
   * read WORKOUT_CONSENT_REQUIRED's sentence, which the service throws first,
   * rather than a generic "consent must be a boolean" from the pipe.
   */
  @IsOptional()
  @IsBoolean()
  consent?: boolean;
}

export class CreatePlanDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, WORKOUT_LIMITS.planNameMax)
  name!: string;

  @IsBoolean()
  makeActive!: boolean;
}

export class PatchPlanDto {
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, WORKOUT_LIMITS.planNameMax)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** `{ plan }` — the whole body, validated by `parseMemberPlan` in the service. */
export class PutPlanBodyDto {
  @IsDefined()
  plan!: unknown;
}

export class SwapDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @IsInt()
  @Min(0)
  @Max(WORKOUT_LIMITS.exercisesMax - 1)
  index!: number;
}

export class AdjustDto {
  @IsInt()
  @Min(0)
  @Max(6)
  weekday!: number;

  @IsOptional()
  @IsIn(WORKOUT_ADJUST_PRESETS)
  preset?: WorkoutAdjustPreset;

  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(1, WORKOUT_LIMITS.adjustRequestMax)
  request?: string;
}

export class GuideQueryDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, WORKOUT_LIMITS.exerciseNameMax)
  exercise!: string;
}
