import { Body, Controller, Post } from '@nestjs/common';
import { IsOptional } from 'class-validator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ConfirmDto, assertConfirmed } from '../common/dto/confirm.dto';
import { IsGymDate } from '../common/validators/is-gym-date.validator';
import { GymConfigService } from '../config/gym.config';
import { asCivilDate, gymToday, type CivilDate } from '../common/time/gym-time';
import { MembershipNightlyJob, type NightlyRunResult } from './membership-nightly.job';

/**
 * `runFor` exists so a post-downtime catch-up can be replayed one missed day at
 * a time when an operator wants to watch it, and defaults to gym today.
 */
export class RunJobDto extends ConfirmDto {
  @IsOptional()
  @IsGymDate()
  runFor?: CivilDate;
}

/** Route 41. There is no JobRun table — the job is stateless and date-driven. */
@Controller('admin/jobs')
export class AdminJobsController {
  constructor(
    private readonly job: MembershipNightlyJob,
    private readonly gym: GymConfigService,
  ) {}

  @Post('membership-nightly')
  @RequirePermission('job.run')
  async runNightly(@Body() dto: RunJobDto): Promise<NightlyRunResult> {
    assertConfirmed(dto);
    const now = new Date();
    const today = dto.runFor ? asCivilDate(dto.runFor) : gymToday(now, this.gym.timeZone);
    return this.job.runFor(today, now);
  }
}
