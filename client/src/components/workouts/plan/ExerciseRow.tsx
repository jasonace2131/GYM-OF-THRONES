import { dose, doseLine, restLabel } from '@/lib/workouts/planView';
import { cn } from '@/lib/utils';
import { IconInfo, IconSwap } from '../icons';
import { PlainButton, Tag } from '../ui';

/**
 * What a row shows. A member plan's exercise fits as it is; a coach's has no
 * muscles and no rest of its own (`null`), and the row then shows neither
 * rather than inventing them.
 */
export interface RowExercise {
  name: string;
  muscles: string | null;
  sets: number;
  reps: string;
  restSeconds: number | null;
  notes?: string;
}

/**
 * One exercise: number · name / muscles / note · dose · rest · How to / Swap.
 * On a phone the two buttons are 44px icon squares (PhoneToday.dc.html);
 * from @2xl they grow their labels. The SWAPPED tag and its Undo appear on
 * the row a swap changed.
 */
export function ExerciseRow({
  index,
  exercise,
  swapped,
  howOpen,
  swapOpen,
  toolbelt,
  busy,
  onHow,
  onSwap,
  onUndoSwap,
}: {
  index: number;
  exercise: RowExercise;
  swapped: boolean;
  howOpen: boolean;
  swapOpen: boolean;
  /** Draft mode has no Swap (there is no plan id to swap against yet). */
  toolbelt: 'full' | 'howOnly';
  busy: boolean;
  onHow: () => void;
  onSwap: () => void;
  onUndoSwap: () => void;
}) {
  const btn =
    'inline-flex h-11 min-w-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[10px] border-0 px-3 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-60 @2xl:h-[38px] @2xl:w-auto @2xl:rounded-lg @2xl:border-[1.5px] @2xl:px-3';

  return (
    // Phones: number + name on the first line, How to / Swap under the name —
    // beside it, two 44px buttons squeezed the name to ~167px and 2-3 lines.
    <div className="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 px-4 py-3 @2xl:grid-cols-[30px_minmax(0,1fr)_118px_78px_196px] @2xl:gap-3.5 @2xl:px-[22px] @2xl:py-3.5">
      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-paper-3 text-[12.5px] font-bold text-[color:var(--p-ink)]">
        {index + 1}
      </span>
      <div className="flex min-w-0 flex-col gap-[3px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[14.5px] font-semibold @2xl:text-[15.5px]">{exercise.name}</span>
          {swapped ? (
            <>
              <Tag tone="info" className="px-2 py-0.5 text-[11px] tracking-[0.08em]">
                Swapped
              </Tag>
              <PlainButton tone="link" onClick={onUndoSwap} disabled={busy}>
                Undo
              </PlainButton>
            </>
          ) : null}
        </div>
        <span
          className={cn('text-[12.5px] text-ink-3', exercise.muscles === null && '@2xl:hidden')}
        >
          <span className="@2xl:hidden">
            {exercise.restSeconds === null
              ? dose(exercise)
              : doseLine({ ...exercise, restSeconds: exercise.restSeconds })}
          </span>
          {exercise.muscles === null ? null : (
            <span className="hidden @2xl:inline">{exercise.muscles}</span>
          )}
        </span>
        {exercise.notes === undefined ? null : (
          <span className="text-[12.5px] text-ink-2 italic">{exercise.notes}</span>
        )}
      </div>
      <span className="hidden text-right font-display text-[16px] font-bold @2xl:block">
        {dose(exercise)}
      </span>
      <span className="hidden text-right text-[12.5px] text-ink-3 @2xl:block">
        {exercise.restSeconds === null ? '' : restLabel(exercise.restSeconds)}
      </span>
      <div className="col-start-2 flex justify-start gap-1.5 @2xl:col-start-auto @2xl:justify-end">
        <button
          type="button"
          aria-expanded={howOpen}
          aria-label={`How to do ${exercise.name}`}
          onClick={onHow}
          className={cn(
            btn,
            howOpen
              ? 'bg-info-bg text-info @2xl:border-[#9fb6e6]'
              : 'bg-[#f4f7fd] text-info @2xl:border-[rgba(26,26,26,0.16)] @2xl:bg-card @2xl:text-foreground',
          )}
        >
          <IconInfo size={18} className="@2xl:hidden" />
          <IconInfo size={15} className="hidden @2xl:block" />
          <span>How to</span>
        </button>
        {toolbelt === 'full' ? (
          <button
            type="button"
            aria-expanded={swapOpen}
            aria-label={`Swap ${exercise.name}`}
            disabled={busy}
            onClick={onSwap}
            className={cn(
              btn,
              swapOpen
                ? 'bg-warn-bg text-warn @2xl:border-gold'
                : 'bg-warn-bg text-warn @2xl:border-[rgba(26,26,26,0.16)] @2xl:bg-card @2xl:text-foreground',
            )}
          >
            <IconSwap size={18} className="@2xl:hidden" />
            <IconSwap size={15} className="hidden @2xl:block" />
            <span>Swap</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}
