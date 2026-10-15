import type { Segment } from '@/lib/workouts/sessionState';
import { cn } from '@/lib/utils';

const TONE: Record<Segment, string> = {
  done: 'bg-ok',
  current: 'bg-gold',
  todo: 'bg-paper-3',
};

/**
 * One bar per exercise: green when every set is ticked, gold for the one on
 * screen, grey for the rest. `header` is the session header's 5px bar;
 * `card` the hub's 6px one. Decorative — the numbers beside it say the same.
 */
export function SegmentBar({
  segments,
  size,
  className,
}: {
  segments: readonly Segment[];
  size: 'header' | 'card';
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn('grid', size === 'header' ? 'gap-[3px]' : 'gap-1', className)}
      style={{ gridTemplateColumns: `repeat(${Math.max(1, segments.length)}, minmax(0, 1fr))` }}
    >
      {segments.map((segment, i) => (
        <span
          key={i}
          className={cn(
            'rounded-[3px] transition-colors duration-300 motion-reduce:transition-none',
            size === 'header' ? 'h-[5px]' : 'h-1.5',
            TONE[segment],
          )}
        />
      ))}
    </div>
  );
}
