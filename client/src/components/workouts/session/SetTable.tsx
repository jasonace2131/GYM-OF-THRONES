'use client';

import type { SetRow } from '@/lib/workouts/sessionState';
import { formatKg } from '@/lib/workouts/sessionState';
import { cn } from '@/lib/utils';
import { IconCheck } from '../icons';
import { Stepper } from './Stepper';

/** SET · KG · REPS · DONE — one grid for the header and every row. */
const GRID =
  'grid grid-cols-[30px_minmax(0,1fr)_minmax(0,1fr)_48px] gap-2 @max-[310px]:grid-cols-[26px_minmax(0,1fr)_minmax(0,1fr)_48px] @max-[310px]:gap-1.5';

export interface SetTableHandlers {
  onStepWeight: (setIndex: number, direction: 1 | -1) => void;
  onStepReps: (setIndex: number, direction: 1 | -1) => void;
  onTypeWeight: (setIndex: number, text: string) => void;
  onTypeReps: (setIndex: number, text: string) => void;
  onToggle: (setIndex: number) => void;
}

/**
 * The sets of the exercise on screen (PhoneSession.dc.html). A ticked row is
 * green; the first unticked one is the CURRENT set, ringed in gold. The tick
 * is a real toggle button — `aria-pressed`, "Done: set 2" — 48×44.
 */
export function SetTable({ rows, ...handlers }: { rows: readonly SetRow[] } & SetTableHandlers) {
  const current = rows.findIndex((row) => !row.done);
  return (
    <div role="table" aria-label="Sets" className="flex flex-col gap-1.5">
      <div
        role="row"
        className={cn(GRID, 'px-0.5 text-[10.5px] font-bold tracking-[0.12em] text-ink-3')}
      >
        <span role="columnheader">SET</span>
        <span role="columnheader" className="text-center">
          KG
        </span>
        <span role="columnheader" className="text-center">
          REPS
        </span>
        <span role="columnheader" className="text-center">
          DONE
        </span>
      </div>
      {rows.map((row, j) => {
        const n = j + 1;
        return (
          <div
            key={j}
            role="row"
            className={cn(
              GRID,
              'items-center rounded-xl px-0.5 py-1 transition-[background-color,box-shadow] duration-200 motion-reduce:transition-none',
              row.done
                ? 'bg-[#eef7f1]'
                : j === current
                  ? 'bg-[#fffaf0] shadow-[inset_0_0_0_1.5px_var(--gold)]'
                  : 'bg-transparent',
            )}
          >
            <span
              role="cell"
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-full text-[12.5px] font-bold',
                row.done ? 'bg-ok text-white' : 'bg-[#f2f0ec] text-[color:var(--p-ink)]',
              )}
            >
              {n}
            </span>
            <Stepper
              display={row.weightKg === null ? '' : formatKg(row.weightKg)}
              placeholder="BW"
              inputMode="decimal"
              inputLabel={`Weight in kg, set ${n}. Blank is bodyweight.`}
              downLabel={`Less weight, set ${n}`}
              upLabel={`More weight, set ${n}`}
              onStep={(direction) => handlers.onStepWeight(j, direction)}
              onCommit={(text) => handlers.onTypeWeight(j, text)}
            />
            <Stepper
              display={String(row.reps)}
              inputMode="numeric"
              inputLabel={`Reps, set ${n}`}
              downLabel={`Fewer reps, set ${n}`}
              upLabel={`More reps, set ${n}`}
              onStep={(direction) => handlers.onStepReps(j, direction)}
              onCommit={(text) => handlers.onTypeReps(j, text)}
            />
            <div role="cell" className="flex justify-center">
              <button
                type="button"
                aria-pressed={row.done}
                aria-label={`Done: set ${n}`}
                onClick={() => handlers.onToggle(j)}
                className={cn(
                  'flex h-11 w-12 cursor-pointer items-center justify-center rounded-[10px] transition-[background-color,border-color,transform] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold active:scale-[0.96] motion-reduce:transition-none motion-reduce:active:scale-100',
                  row.done
                    ? 'border-0 bg-ok text-white'
                    : 'border-[1.5px] border-[rgba(26,26,26,0.2)] bg-card text-[#bdb8b0]',
                )}
              >
                <IconCheck size={20} strokeWidth={2.8} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
