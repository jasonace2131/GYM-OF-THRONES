import type { MemberPlanDay, WorkoutDraftView } from '@got/shared';
import { WEEKDAY_LONG } from './labels';

/**
 * The generating screen's progress, read off the draft itself: `summary`
 * lands first, then one day per intake weekday in order, then `guidance`.
 * The only timing shown is the server's `firstDayMs` — REQ034's evidence —
 * never a number invented on the client.
 */

export type StepState = 'done' | 'active' | 'pending';

export interface ProgressStep {
  key: string;
  label: string;
  detail: string | null;
  state: StepState;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

export function progressSteps(draft: WorkoutDraftView): ProgressStep[] {
  const ready = draft.status === 'READY';
  const summaryDone = ready || draft.plan.summary !== null;
  const written = new Set(draft.plan.days.map((d) => d.weekday));
  const weekdays = [...draft.intake.weekdays].sort((a, b) => a - b);

  const steps: ProgressStep[] = [
    {
      key: 'read',
      label: 'Read your answers',
      detail: null,
      state: summaryDone ? 'done' : 'active',
    },
  ];

  let activeTaken = !summaryDone;
  weekdays.forEach((weekday, i) => {
    const done = ready || written.has(weekday);
    const active = !done && !activeTaken;
    if (active) activeTaken = true;
    steps.push({
      key: `day-${weekday}`,
      label: `Day ${i + 1} · ${WEEKDAY_LONG[weekday] ?? ''}`,
      detail:
        done && i === 0 && draft.firstDayMs !== null
          ? `Ready in ${seconds(draft.firstDayMs)}`
          : active
            ? 'Writing…'
            : null,
      state: done ? 'done' : active ? 'active' : 'pending',
    });
  });

  const tipsDone = ready || draft.plan.guidance !== null;
  steps.push({
    key: 'tips',
    label: 'Wellness tips',
    detail: !tipsDone && !activeTaken ? 'Writing…' : null,
    state: tipsDone ? 'done' : activeTaken ? 'pending' : 'active',
  });
  return steps;
}

export function progressPercent(steps: readonly ProgressStep[]): number {
  const done = steps.filter((s) => s.state === 'done').length;
  return steps.length === 0 ? 0 : Math.round((done / steps.length) * 100);
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The `role="status"` line under the title. */
export function statusLine(draft: WorkoutDraftView): string {
  if (draft.status === 'READY') return 'Your plan is ready.';
  if (draft.status === 'FAILED') return 'The AI stopped part-way.';
  if (draft.plan.summary === null) return 'Reading your answers…';

  const weekdays = [...draft.intake.weekdays].sort((a, b) => a - b);
  const written = new Set(draft.plan.days.map((d) => d.weekday));
  const done = weekdays.filter((d) => written.has(d)).map((d) => WEEKDAY_LONG[d] ?? '');
  const next = weekdays.find((d) => !written.has(d));

  if (next === undefined) return 'Every day is ready. Writing your wellness tips…';
  const writing = `Writing ${WEEKDAY_LONG[next]} now.`;
  if (done.length === 0) return writing;
  return `${joinNames(done)} ${done.length === 1 ? 'is' : 'are'} ready. ${writing}`;
}

export interface DraftDayCard {
  index: number;
  weekday: number;
  day: MemberPlanDay | null;
  state: 'ready' | 'writing' | 'pending';
}

/** One card per intake weekday; the first unwritten one is "writing". */
export function dayCards(draft: WorkoutDraftView): DraftDayCard[] {
  const weekdays = [...draft.intake.weekdays].sort((a, b) => a - b);
  let writingTaken = draft.status !== 'RUNNING';
  return weekdays.map((weekday, index) => {
    const day = draft.plan.days.find((d) => d.weekday === weekday) ?? null;
    if (day !== null) return { index, weekday, day, state: 'ready' };
    const state = writingTaken ? 'pending' : 'writing';
    writingTaken = true;
    return { index, weekday, day: null, state };
  });
}
