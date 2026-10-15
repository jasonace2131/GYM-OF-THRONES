import { cn } from '@/lib/utils';

/**
 * "New", said twice: a gold dot for the eye that scans, and the word itself
 * for everyone else — status is never carried by colour alone.
 */
export function NewMarker({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 font-display text-[10.5px] font-semibold uppercase leading-none tracking-[0.12em] text-gold-deep',
        className,
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-gold" />
      New
    </span>
  );
}
