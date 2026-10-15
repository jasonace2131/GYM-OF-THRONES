import type { WorkoutAiQuotaView } from '@got/shared';
import { quotaPill, quotaShort } from '@/lib/workouts/quota';
import { cn } from '@/lib/utils';
import { IconSparkles } from './icons';

/**
 * "5 of 8 AI actions left today" — the header pill. Reads short ("5 left")
 * where there is no room, and stays a `<span>` because it is a fact, not a
 * control.
 */
export function QuotaPill({
  quota,
  className,
}: {
  quota: WorkoutAiQuotaView | null;
  className?: string;
}) {
  if (quota === null) return null;
  const spent = quota.remaining <= 0;
  return (
    <span
      className={cn(
        'inline-flex h-[34px] items-center gap-2 rounded-full px-3.5 text-[13px] font-semibold',
        spent ? 'bg-paper-3 text-ink-2' : 'bg-warn-bg text-warn',
        className,
      )}
      aria-label={quotaPill(quota)}
    >
      <IconSparkles size={16} />
      <span className="hidden @md:inline">{quotaPill(quota)}</span>
      <span className="@md:hidden">{quotaShort(quota)}</span>
    </span>
  );
}
