import type {
  NewBest,
  SessionExerciseSummary,
  WorkoutFeeling,
  WorkoutSessionSummary,
} from '@got/shared';
import { WEEKDAY_LONG, WEEKDAY_SHORT } from './labels';

/**
 * How a finished workout is written — the Recent workouts rows
 * (PhoneHubCoach.dc.html), the "Workout done" screen (PhoneFinish.dc.html)
 * and the history pages. Everything comes from the server's summary; the
 * only rule computed here is wording.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GROUPED = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

/** "4,435 kg", "37.5 kg". */
export function kgText(kg: number): string {
  return `${GROUPED.format(kg)} kg`;
}

/** "46 min", "1 h 12 min". */
export function durationText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function weekdayOf(civil: string): number {
  return new Date(`${civil}T00:00:00.000Z`).getUTCDay();
}

/** "Wed, Sep 30" — a civil date, read through UTC so no zone can move it. */
export function sessionDate(civil: string): string {
  const month = MONTHS[Number(civil.slice(5, 7)) - 1] ?? '';
  return `${WEEKDAY_SHORT[weekdayOf(civil)] ?? ''}, ${month} ${Number(civil.slice(8, 10))}`;
}

const setsWord = (n: number): string => `${n} ${n === 1 ? 'set' : 'sets'}`;

export function summaryHref(id: string, just = false): string {
  return `/portal/workouts/history/${encodeURIComponent(id)}${just ? '?just=1' : ''}`;
}

export interface RecentRow {
  id: string;
  title: string;
  when: string;
  volume: string;
  href: string;
}

function volumeText(summary: Pick<WorkoutSessionSummary, 'volumeKg'>): string {
  return summary.volumeKg > 0 ? kgText(summary.volumeKg) : 'Bodyweight';
}

/** One row of Recent workouts and of the history list. */
export function recentRow(summary: WorkoutSessionSummary): RecentRow {
  return {
    id: summary.id,
    title: summary.dayTitle,
    when: `${sessionDate(summary.businessDate)} · ${durationText(summary.durationMinutes)} · ${setsWord(summary.setsDone)}`,
    volume: volumeText(summary),
    href: summaryHref(summary.id),
  };
}

/** Under "Workout done": "Full body B · 46 min · Wed, Sep 30". */
export function finishLine(summary: WorkoutSessionSummary): string {
  return `${summary.dayTitle} · ${durationText(summary.durationMinutes)} · ${sessionDate(summary.businessDate)}`;
}

/** Under a history entry's title: "Wed, Sep 30 · 46 min · Beginner Muscle". */
export function plainLine(summary: WorkoutSessionSummary): string {
  return `${sessionDate(summary.businessDate)} · ${durationText(summary.durationMinutes)} · ${summary.planName}`;
}

export interface StatTile {
  value: string;
  /** Rendered in capitals by the tile. */
  label: string;
  highlight: boolean;
}

export function statTiles(summary: WorkoutSessionSummary): StatTile[] {
  const bests = summary.bests.length;
  return [
    { value: String(summary.setsDone), label: 'Sets done', highlight: false },
    {
      value: `${summary.exercisesDone} / ${summary.exerciseCount}`,
      label: 'Exercises',
      highlight: false,
    },
    { value: volumeText(summary), label: 'Weight moved', highlight: false },
    { value: String(bests), label: bests === 1 ? 'New best' : 'New bests', highlight: bests > 0 },
  ];
}

/** "14 kg × 10 — up from 12 kg". The previous best has no date on the wire, so none is claimed. */
export function bestLine(best: NewBest): string {
  return `${kgText(best.weightKg)} × ${best.reps} — up from ${kgText(best.previousKg)}`;
}

/** WHAT YOU DID: "3 sets · top 80 kg × 12", "2 of 3 sets · bodyweight × 8". */
export function exerciseLine(exercise: SessionExerciseSummary): string {
  if (exercise.setsDone === 0 || exercise.top === null) return 'Not done';
  const count =
    exercise.setsDone < exercise.plannedSets
      ? `${exercise.setsDone} of ${exercise.plannedSets} sets`
      : setsWord(exercise.setsDone);
  const { weightKg, reps } = exercise.top;
  const top =
    weightKg === null
      ? `bodyweight × ${reps}`
      : `${exercise.setsDone > 1 ? 'top ' : ''}${kgText(weightKg)} × ${reps}`;
  return `${count} · ${top}`;
}

export function savedFootnote(summary: WorkoutSessionSummary): string {
  const day = WEEKDAY_LONG[weekdayOf(summary.businessDate)] ?? 'Today';
  return `Saved to your history — ${day} is ticked on your week.`;
}

export const FEELING_OPTIONS: readonly { value: WorkoutFeeling; label: string }[] = [
  { value: 'EASY', label: 'Easy' },
  { value: 'RIGHT', label: 'Just right' },
  { value: 'HARD', label: 'Hard' },
];

export function feelingLabel(feeling: WorkoutFeeling): string {
  return FEELING_OPTIONS.find((o) => o.value === feeling)?.label ?? feeling;
}
