const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MINUTES_PER_DAY = 1440;

/**
 * Turns a configured `HH:mm` plus an offset in minutes into a daily cron
 * expression — `GYM_CLOSE_TIME` + 15 becomes '15 22 * * *'.
 *
 * The schedule depends on configuration, which is why jobs are registered
 * through SchedulerRegistry at bootstrap rather than with static `@Cron`
 * decorators: a decorator argument cannot read GymConfigService.
 *
 * Hour rollover is handled in both directions, so a close time near midnight
 * plus an offset lands on the following day rather than producing an
 * out-of-range hour that `cron` accepts and then never fires.
 */
export function cronAt(timeOfDay: string, offsetMinutes = 0): string {
  const match = HH_MM.exec(timeOfDay);
  if (!match) {
    throw new Error(`cronAt: "${timeOfDay}" is not an HH:mm time of day`);
  }

  const raw = Number(match[1]) * 60 + Number(match[2]) + offsetMinutes;
  const normalised = ((raw % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;

  return `${normalised % 60} ${Math.floor(normalised / 60)} * * *`;
}
