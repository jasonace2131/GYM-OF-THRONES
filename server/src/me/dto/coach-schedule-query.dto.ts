import { IsOptional } from 'class-validator';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import type { CivilDate } from '../../common/time/gym-time';

/**
 * The window the coach's schedule covers, as gym-local civil dates.
 *
 * Both optional: omitting them means "this week", which is what the dashboard
 * opens on. Deliberately NOT instants — a week boundary is a civil-date fact,
 * and an ISO instant range would file a 06:00 Manila class under the previous
 * day, which is exactly the bug `businessDate` exists to prevent.
 *
 * There is no `coachId` here, and there must never be one: these routes read
 * the coach off the token. See the header of `coaching.service.ts`.
 */
export class CoachScheduleQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;
}
