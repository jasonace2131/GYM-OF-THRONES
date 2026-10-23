import {
  WORKOUT_EASY_ON,
  WORKOUT_EXPERIENCE,
  WORKOUT_GOALS,
  WORKOUT_LIMITS,
  WORKOUT_SESSION_MINUTES,
  WORKOUT_TIMES_OF_DAY,
  parseWorkoutIntake,
  type ParseResult,
  type WorkoutEasyOn,
  type WorkoutExperience,
  type WorkoutGoal,
  type WorkoutIntake,
  type WorkoutIntakeSummary,
  type WorkoutSessionMinutes,
  type WorkoutTimeOfDay,
} from '@got/shared';
import { bodySummary, type AccountBody } from './body';
import { GOAL_LABEL, LEVEL_LABEL, TIME_LABEL, easyOnPhrase, weekdayList } from './labels';

/**
 * The wizard's state machine.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SEVEN PAR-Q+ ANSWERS LIVE IN `parq` AND NOWHERE ELSE.
 *
 * `buildRequest` is the only door to the wire, and it reduces them to one
 * boolean (`healthFlag`, any "yes") before `parseWorkoutIntake` — the shared
 * parser — sees the object. It has no field for the answers, and rejects any
 * unknown key, so even a future mistake here would be refused, not sent.
 * `serializeIntake` keeps them for THIS TAB's "Try again" only
 * (sessionStorage), never for a server.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type IntakeStep = 1 | 2 | 3 | 4;

export const STEP_LABELS = ['Goal', 'About you', 'Your week', 'Health check'] as const;

export const PARQ_COUNT = 7;

export interface IntakeState {
  step: IntakeStep;
  /** The member pressed Next on an incomplete step; show what is missing. */
  attempted: boolean;
  goal: WorkoutGoal | null;
  goalNotes: string;
  experience: WorkoutExperience | null;
  use: WorkoutIntake['use'];
  /** Sorted, unique, 0 = Sunday. */
  weekdays: number[];
  sessionMinutes: WorkoutSessionMinutes;
  timeOfDay: WorkoutTimeOfDay;
  /** The PAR-Q+ answers. Browser only. */
  parq: boolean[];
  easyOn: WorkoutEasyOn[];
  consent: boolean;
}

export type IntakeAction =
  | { type: 'restore'; state: IntakeState }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'goto'; step: IntakeStep }
  | { type: 'goal'; goal: WorkoutGoal }
  | { type: 'goalNotes'; value: string }
  | { type: 'experience'; experience: WorkoutExperience }
  | { type: 'use'; key: keyof WorkoutIntake['use']; value: boolean }
  | { type: 'toggleDay'; weekday: number }
  | { type: 'minutes'; value: WorkoutSessionMinutes }
  | { type: 'timeOfDay'; value: WorkoutTimeOfDay }
  | { type: 'parq'; index: number; value: boolean }
  | { type: 'toggleEasyOn'; area: WorkoutEasyOn }
  | { type: 'consent'; value: boolean };

export function initialIntake(): IntakeState {
  return {
    step: 1,
    attempted: false,
    goal: null,
    goalNotes: '',
    experience: null,
    use: { measurements: true, attendance: true, bookings: true },
    weekdays: [],
    sessionMinutes: 45,
    timeOfDay: 'EVENING',
    parq: Array.from({ length: PARQ_COUNT }, () => false),
    easyOn: [],
    consent: false,
  };
}

/** What stops this step, or null when it is complete. */
export function stepProblem(state: IntakeState, step: IntakeStep): string | null {
  switch (step) {
    case 1:
      if (state.goal === null) return 'Pick a goal to continue.';
      if (state.goalNotes.trim().length > WORKOUT_LIMITS.goalNotesMax)
        return `Keep your own words under ${WORKOUT_LIMITS.goalNotesMax} characters.`;
      return null;
    case 2:
      return state.experience === null ? 'Pick your experience level.' : null;
    case 3:
      return state.weekdays.length === 0 ? 'Pick at least one day.' : null;
    case 4:
      return state.consent ? null : 'Tick the consent box first.';
  }
}

/**
 * A step pill is clickable back to any completed step, and to the current.
 * Never forward: Next is the only way on, so a step cannot be skipped past
 * its check.
 */
export function canGoTo(state: IntakeState, step: IntakeStep): boolean {
  return step <= state.step;
}

export function healthFlag(state: Pick<IntakeState, 'parq'>): boolean {
  return state.parq.some(Boolean);
}

export function intakeReducer(state: IntakeState, action: IntakeAction): IntakeState {
  switch (action.type) {
    case 'restore':
      return action.state;
    case 'next': {
      if (state.step === 4) return state;
      if (stepProblem(state, state.step) !== null) return { ...state, attempted: true };
      return { ...state, step: (state.step + 1) as IntakeStep, attempted: false };
    }
    case 'back':
      return state.step === 1
        ? state
        : { ...state, step: (state.step - 1) as IntakeStep, attempted: false };
    case 'goto':
      return canGoTo(state, action.step)
        ? { ...state, step: action.step, attempted: false }
        : state;
    case 'goal':
      return { ...state, goal: action.goal };
    case 'goalNotes':
      return { ...state, goalNotes: action.value };
    case 'experience':
      return { ...state, experience: action.experience };
    case 'use':
      return { ...state, use: { ...state.use, [action.key]: action.value } };
    case 'toggleDay': {
      const on = state.weekdays.includes(action.weekday);
      const weekdays = on
        ? state.weekdays.filter((d) => d !== action.weekday)
        : [...state.weekdays, action.weekday].sort((a, b) => a - b);
      return { ...state, weekdays };
    }
    case 'minutes':
      return { ...state, sessionMinutes: action.value };
    case 'timeOfDay':
      return { ...state, timeOfDay: action.value };
    case 'parq': {
      if (action.index < 0 || action.index >= PARQ_COUNT) return state;
      const parq = state.parq.map((v, i) => (i === action.index ? action.value : v));
      return { ...state, parq };
    }
    case 'toggleEasyOn': {
      const on = state.easyOn.includes(action.area);
      return {
        ...state,
        easyOn: on ? state.easyOn.filter((a) => a !== action.area) : [...state.easyOn, action.area],
      };
    }
    case 'consent':
      return { ...state, consent: action.value };
  }
}

/**
 * The wire body. Built field by field — never a spread of the state — so
 * `parq` cannot ride along, then validated by the parser both runtimes share.
 */
export function buildRequest(state: IntakeState): ParseResult<WorkoutIntake> {
  const notes = state.goalNotes.trim();
  const candidate: Record<string, unknown> = {
    goal: state.goal,
    experience: state.experience,
    weekdays: state.weekdays,
    sessionMinutes: state.sessionMinutes,
    timeOfDay: state.timeOfDay,
    healthFlag: healthFlag(state),
    easyOn: state.easyOn,
    use: state.use,
    consent: state.consent,
  };
  if (notes !== '') candidate['goalNotes'] = notes;
  return parseWorkoutIntake(candidate);
}

/** Regenerate / lastIntake: everything but the answers and the consent. */
export function prefillIntake(summary: WorkoutIntakeSummary | null): IntakeState {
  const blank = initialIntake();
  if (summary === null) return blank;
  return {
    ...blank,
    goal: summary.goal,
    goalNotes: summary.goalNotes ?? '',
    experience: summary.experience,
    use: { ...summary.use },
    weekdays: [...summary.weekdays].sort((a, b) => a - b),
    sessionMinutes: summary.sessionMinutes,
    timeOfDay: summary.timeOfDay,
    easyOn: [...summary.easyOn],
  };
}

/** For sessionStorage in this tab, so "Try again" after a FAILED draft keeps the form. */
export function serializeIntake(state: IntakeState): string {
  return JSON.stringify(state);
}

const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value);

/** Lands on the last step, everything kept. Null for anything malformed. */
export function restoreIntake(json: string | null): IntakeState | null {
  if (json === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const use = r['use'];
  const parq = r['parq'];
  const weekdays = r['weekdays'];
  const easyOn = r['easyOn'];
  if (
    !(r['goal'] === null || isOneOf(r['goal'], WORKOUT_GOALS)) ||
    !(r['experience'] === null || isOneOf(r['experience'], WORKOUT_EXPERIENCE)) ||
    typeof r['goalNotes'] !== 'string' ||
    !Array.isArray(weekdays) ||
    !weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
    !(WORKOUT_SESSION_MINUTES as readonly number[]).includes(r['sessionMinutes'] as number) ||
    !isOneOf(r['timeOfDay'], WORKOUT_TIMES_OF_DAY) ||
    !Array.isArray(parq) ||
    parq.length !== PARQ_COUNT ||
    !parq.every((v) => typeof v === 'boolean') ||
    !Array.isArray(easyOn) ||
    !easyOn.every((a) => isOneOf(a, WORKOUT_EASY_ON)) ||
    use === null ||
    typeof use !== 'object' ||
    typeof (use as Record<string, unknown>)['measurements'] !== 'boolean' ||
    typeof (use as Record<string, unknown>)['attendance'] !== 'boolean' ||
    typeof (use as Record<string, unknown>)['bookings'] !== 'boolean' ||
    typeof r['consent'] !== 'boolean'
  ) {
    return null;
  }
  const u = use as Record<string, boolean>;
  return {
    step: 4,
    attempted: false,
    goal: r['goal'] as WorkoutGoal | null,
    goalNotes: r['goalNotes'],
    experience: r['experience'] as WorkoutExperience | null,
    use: {
      measurements: u['measurements']!,
      attendance: u['attendance']!,
      bookings: u['bookings']!,
    },
    weekdays: [...(weekdays as number[])].sort((a, b) => a - b),
    sessionMinutes: r['sessionMinutes'] as WorkoutSessionMinutes,
    timeOfDay: r['timeOfDay'] as WorkoutTimeOfDay,
    parq: parq as boolean[],
    easyOn: easyOn as WorkoutEasyOn[],
    consent: r['consent'],
  };
}

/** YOUR PLAN SO FAR. */
export function summaryRows(
  state: IntakeState,
  body: AccountBody | null = null,
): [string, string][] {
  return [
    ['Goal', state.goal === null ? 'Not picked yet' : GOAL_LABEL[state.goal].title],
    ['Level', state.experience === null ? 'Not picked yet' : LEVEL_LABEL[state.experience].title],
    ['Days', weekdayList(state.weekdays)],
    ['Sessions', `${state.sessionMinutes} min · ${TIME_LABEL[state.timeOfDay]}`],
    ['Health', healthFlag(state) ? 'Keep it gentle' : 'No flags'],
    ['Go easy on', state.easyOn.length === 0 ? 'Nothing' : easyOnPhrase(state.easyOn)],
    ['Body', bodySummary(body)],
  ];
}

/** The gym-held facts the switches govern, already phrased; null when absent. */
export interface GymFacts {
  measurements: string | null;
  attendance: string | null;
  bookings: string | null;
}

/** WHAT THE AI SEES — and, by omission, what it never does. */
export function whatAiSees(state: IntakeState, facts: GymFacts): string[] {
  const lines = ['Goal, level, days and session length'];
  if (state.use.measurements && facts.measurements !== null)
    lines.push(`Weight and height: ${facts.measurements}`);
  if (state.use.attendance && facts.attendance !== null)
    lines.push(`Attendance: ${facts.attendance}`);
  if (state.use.bookings && facts.bookings !== null) lines.push(`Booked class: ${facts.bookings}`);
  lines.push('Gym opening hours for each day');
  lines.push(healthFlag(state) ? 'Health: keep it gentle' : 'Health: no flags');
  if (state.easyOn.length > 0) lines.push(`Go easy on: ${easyOnPhrase(state.easyOn)}`);
  return lines;
}

/** "NEXT: ABOUT YOU", or null on the last step (where Generate lives). */
export function nextLabel(step: IntakeStep): string | null {
  const label = (STEP_LABELS as readonly string[])[step];
  return label === undefined ? null : `NEXT: ${label.toUpperCase()}`;
}
