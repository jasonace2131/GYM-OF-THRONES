import { Badge } from '@/components/ui/badge';
import type { BookingTone } from '@/lib/schedule/bookingState';
import { cn } from '@/lib/utils';

const TONE: Record<BookingTone, string> = {
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  danger: 'bg-danger-bg text-danger',
  info: 'bg-info-bg text-info',
  neutral: 'bg-paper-3 text-ink-2',
};

/** The portal's pill badge, on shadcn's Badge. Labels come from bookingState(). */
export function StatusBadge({
  tone,
  children,
  className,
}: {
  tone: BookingTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={cn(
        'rounded-full border-transparent px-2.5 py-0.5 font-display text-[10.5px] font-semibold uppercase tracking-[0.1em]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </Badge>
  );
}
