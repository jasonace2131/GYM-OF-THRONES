import type { WorkoutAiQuotaView } from '@got/shared';
import { GYM_TIMEZONE, formatGymTime } from '@/lib/gymTime';

/**
 * Every sentence about the AI budget. The numbers are the server's
 * (`WorkoutAiQuotaView`); this module only phrases them, so the header pill,
 * the hub's meter, the wizard's footer and the 429 notice cannot disagree.
 */

export function quotaPill(quota: WorkoutAiQuotaView): string {
  return quota.remaining <= 0
    ? 'No AI actions left today'
    : `${quota.remaining} of ${quota.limit} AI actions left today`;
}

/** The phone header has room for two words. */
export function quotaShort(quota: WorkoutAiQuotaView): string {
  return `${Math.max(0, quota.remaining)} left`;
}

/** One boolean per segment, used first: `true` is a segment still available. */
export function quotaMeter(quota: WorkoutAiQuotaView): boolean[] {
  return Array.from({ length: quota.limit }, (_, i) => i >= quota.used);
}

/** "Resets at midnight" — or the gym-local clock time, should that ever change. */
export function quotaResetLabel(quota: WorkoutAiQuotaView): string {
  const clock = formatGymTime(quota.resetsAt, GYM_TIMEZONE);
  return clock === '12:00 AM' ? 'Resets at midnight' : `Resets at ${clock}`;
}

/** The lower-case tail for a sentence: "midnight" / "6:30 AM". */
function resetWhen(quota: WorkoutAiQuotaView): string {
  return quotaResetLabel(quota).replace('Resets at ', '');
}

/** Under the Generate button. */
export function generateNote(quota: WorkoutAiQuotaView): string {
  if (quota.remaining <= 0) return `No AI actions left today — they reset at ${resetWhen(quota)}`;
  if (quota.remaining === 1) return 'Uses your last AI action for today';
  return `Uses 1 of your ${quota.remaining} AI actions left today`;
}

export function canSpend(quota: WorkoutAiQuotaView): boolean {
  return quota.remaining > 0;
}

/**
 * The inline notice for a 429 — never a toast: a member who just pressed
 * Generate needs to read when they can press it again.
 */
export function limitNotice(quota: WorkoutAiQuotaView, serverMessage: string | null): string {
  const lead =
    serverMessage === null || serverMessage.trim() === ''
      ? `You have used all ${quota.limit} AI actions for today.`
      : serverMessage.trim();
  return `${lead} They reset at ${resetWhen(quota)}.`;
}
