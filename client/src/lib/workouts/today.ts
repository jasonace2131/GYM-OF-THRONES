import {
  sessionExercisesFromCoachDay,
  type MemberPlanBody,
  type MemberPlanDay,
  type MemberWorkoutPlanView,
  type MyBookingWire,
  type MyCheckInSummary,
  type SessionExercise,
  type StartSessionBody,
  type WorkoutSessionSummary,
  type WorkoutSessionView,
  type WorkoutsHome,
} from '@got/shared';
import { addDays, asCivilDate, type CivilDate } from '@/lib/gymTime';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { coachDayHref, coachDays, coachName, coachPlanTitle } from './coachPlan';
import { durationText, kgText, summaryHref } from './history';
import { TIME_LABEL, WEEKDAY_LONG, WEEKDAY_SHORT, WEEK_ORDER } from './labels';
import { aboutMinutes, dose, doseLine, exerciseCount, restLabel } from './planView';
import { viewProgress } from './sessionState';
import { coachToday, finishedOn, todaySource } from './todaySource';

/**
 * "Today" on the hub and the dashboard, and the THIS WEEK strip — decided
 * from the active plan, the member's check-in days, their live bookings and
 * the GYM's date. Nothing here reads the phone's clock.
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** 0 = Sunday, from a civil date, through UTC so no zone can shift it. */
export function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00.000Z`).getUTCDay();
}

/** Monday of the Monday-start week that holds `day`. */
function mondayOf(day: CivilDate): CivilDate {
  const weekday = weekdayOf(day);
  return addDays(day, weekday === 0 ? -6 : 1 - weekday);
}

/** "TODAY · WEDNESDAY, SEP 30" — or "TODAY · WED, SEP 30" on a phone. */
export function todayKicker(today: CivilDate, length: 'long' | 'short'): string {
  const weekday = weekdayOf(today);
  const name =
    length === 'long'
      ? WEEKDAY_LONG[weekday]?.toUpperCase()
      : WEEKDAY_SHORT[weekday]?.toUpperCase();
  const month = MONTHS[Number(today.slice(5, 7)) - 1];
  return `TODAY · ${name}, ${month} ${Number(today.slice(8, 10))}`;
}

export interface NextSession {
  day: MemberPlanDay;
  /** "Saturday" */
  label: string;
}

/** The next planned day strictly after `weekday`, wrapping past Sunday. */
export function nextSession(plan: MemberPlanBody, weekday: number): NextSession | null {
  if (plan.days.length === 0) return null;
  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = (weekday + offset) % 7;
    const day = plan.days.find((d) => d.weekday === candidate);
    if (day !== undefined) return { day, label: WEEKDAY_LONG[candidate] ?? '' };
  }
  return null;
}

export type TodayView =
  | {
      kind: 'train';
      plan: MemberWorkoutPlanView;
      day: MemberPlanDay;
      dayNumber: number;
      title: string;
      /** "Legs, back and shoulders — day 2 of your active plan," — the name follows in bold. */
      lead: string;
      planName: string;
      chips: string[];
      phoneLine: string;
      startHref: string;
      adjustHref: string;
      next: NextSession | null;
    }
  | {
      kind: 'rest';
      plan: MemberWorkoutPlanView;
      title: 'Rest day';
      lead: string;
      planName: string;
      next: NextSession | null;
      startHref: string | null;
    }
  | { kind: 'none' };

export function todayView(plan: MemberWorkoutPlanView | null, today: CivilDate): TodayView {
  if (plan === null || !plan.isActive) return { kind: 'none' };
  const weekday = weekdayOf(today);
  const index = plan.plan.days.findIndex((d) => d.weekday === weekday);
  const day = plan.plan.days[index];

  if (day !== undefined) {
    const base = `/portal/workouts/${plan.id}`;
    return {
      kind: 'train',
      plan,
      day,
      dayNumber: index + 1,
      title: day.title,
      lead: `${day.focus} — day ${index + 1} of your active plan,`,
      planName: plan.name,
      chips: [
        exerciseCount(day.exercises.length),
        aboutMinutes(day.minutes),
        `${TIME_LABEL[plan.intake.timeOfDay]}, within opening hours`,
      ],
      phoneLine: `${exerciseCount(day.exercises.length)} · about ${day.minutes} min · ${plan.name}`,
      startHref: `${base}#day-${weekday}`,
      adjustHref: `${base}?adjust=${weekday}#day-${weekday}`,
      next: nextSession(plan.plan, weekday),
    };
  }

  const next = nextSession(plan.plan, weekday);
  return {
    kind: 'rest',
    plan,
    title: 'Rest day',
    lead:
      next === null
        ? 'No sessions in your active plan yet,'
        : `Next session: ${next.label} — ${next.day.title}, from your active plan,`,
    planName: plan.name,
    next,
    startHref: next === null ? null : `/portal/workouts/${plan.id}#day-${next.day.weekday}`,
  };
}

/** "Spin 6 PM" (strip) or "Spin class · 6:00 PM (booked)" (rail). */
function classCaption(booking: MyBookingWire, length: 'short' | 'long'): string {
  const clock = gymClock12(booking.session.startsAt);
  if (length === 'long') return `${booking.session.title} class · ${clock} (booked)`;
  return `${booking.session.title} ${clock.replace(':00', '')}`;
}

/** Live BOOKED classes in the gym week that holds `today`, by weekday. */
export function bookedClassesByWeekday(
  bookings: readonly MyBookingWire[],
  today: CivilDate,
  length: 'short' | 'long' = 'short',
): Record<number, string> {
  const monday = mondayOf(today);
  const sunday = addDays(monday, 6);
  const out: Record<number, string> = {};
  const live = bookings
    .filter(
      (b) =>
        b.status === 'BOOKED' &&
        b.session.cancelledAt === null &&
        b.session.businessDate >= monday &&
        b.session.businessDate <= sunday,
    )
    .sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
  for (const booking of live) {
    const weekday = weekdayOf(booking.session.businessDate);
    if (out[weekday] === undefined) out[weekday] = classCaption(booking, length);
  }
  return out;
}

export type WeekKind = 'done' | 'class' | 'today' | 'train' | 'rest';

/** A planned day as the strip needs it — a member plan's day, or a coach day with a weekday. */
export interface StripDay {
  weekday: number;
  title: string;
}

export interface WeekCell {
  weekday: number;
  civil: CivilDate;
  /** "MON" */
  dow: string;
  /** "M" */
  letter: string;
  /** "28" */
  date: string;
  kind: WeekKind;
  caption: string;
  /** The planned session on this weekday, if any — kept even under a tick. */
  session: StripDay | null;
  /** A check-in happened on this date. */
  checkedIn: boolean;
  /** A workout was finished on this gym day. */
  workedOut: boolean;
}

/**
 * Monday to Sunday of the week holding `today`. Precedence: a finished
 * workout ticks any day, today included ("Wednesday is ticked on your
 * week"); otherwise today's gold ring, then a check-in tick, then a booked
 * class, then a planned session, then rest.
 */
export function weekStrip(
  plan: { days: readonly StripDay[] } | null,
  checkIns: MyCheckInSummary | null,
  bookings: readonly MyBookingWire[],
  today: CivilDate,
  workoutDays: readonly string[] = [],
): WeekCell[] {
  const monday = mondayOf(today);
  const visits = new Set((checkIns?.days ?? []).filter((d) => d.count > 0).map((d) => d.date));
  const workouts = new Set(workoutDays);
  const classes = bookedClassesByWeekday(bookings, today);

  return WEEK_ORDER.map((weekday, i) => {
    const civil = addDays(monday, i);
    const found = plan?.days.find((d) => d.weekday === weekday);
    const session = found === undefined ? null : { weekday: found.weekday, title: found.title };
    const checkedIn = visits.has(civil);
    const workedOut = workouts.has(civil);
    const klass = classes[weekday];
    const kind: WeekKind = workedOut
      ? 'done'
      : civil === today
        ? 'today'
        : checkedIn
          ? 'done'
          : klass !== undefined
            ? 'class'
            : session !== null
              ? 'train'
              : 'rest';
    const caption =
      kind === 'today'
        ? 'Today'
        : kind === 'done'
          ? 'Done'
          : kind === 'class'
            ? (klass ?? '')
            : kind === 'train'
              ? (session?.title ?? '')
              : 'Rest';
    return {
      weekday,
      civil: asCivilDate(civil),
      dow: (WEEKDAY_SHORT[weekday] ?? '').toUpperCase(),
      letter: (WEEKDAY_SHORT[weekday] ?? '?').charAt(0),
      date: String(Number(civil.slice(8, 10))),
      kind,
      caption,
      session,
      checkedIn,
      workedOut,
    };
  });
}

function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function tickedSentence(names: string[], from: 'check-in' | 'workout'): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is ticked from your ${from}.`;
  return `${joinNames(names)} are ticked from your ${from}s.`;
}

/** The one line under the strip. A day with a workout credits the workout. */
export function weekExplanation(cells: readonly WeekCell[]): string {
  const name = (c: WeekCell): string => WEEKDAY_LONG[c.weekday] ?? '';
  const visits = cells.filter((c) => c.checkedIn && !c.workedOut).map(name);
  const workouts = cells.filter((c) => c.workedOut).map(name);
  const classes = cells.filter((c) => c.kind === 'class');
  const parts: string[] = [];
  const fromVisits = tickedSentence(visits, 'check-in');
  const fromWorkouts = tickedSentence(workouts, 'workout');
  if (fromVisits !== null) parts.push(fromVisits);
  if (fromWorkouts !== null) parts.push(fromWorkouts);
  for (const cell of classes) {
    const title = cell.caption.replace(/\s\d{1,2}(:\d{2})?\s[AP]M$/, '');
    parts.push(`Your ${WEEKDAY_LONG[cell.weekday]} ${title} class counts as cardio.`);
  }
  return parts.length === 0
    ? 'Planned days are outlined in gold; a tick appears when you check in or finish a workout.'
    : parts.join(' ');
}

/** "1 of 3 training days done" — planned days this week with a check-in or a workout. */
export function trainingProgress(
  cells: readonly WeekCell[],
  plan: { days: readonly unknown[] },
): { done: number; total: number } {
  const done = cells.filter((c) => c.session !== null && (c.checkedIn || c.workedOut)).length;
  return { done, total: plan.days.length };
}

// ── Today, whole (feat/workout-sessions) ────────────────────────────────

/** One row of TODAY'S EXERCISES — `rest` is null for a coach's plan, which sets none. */
export interface TodayExerciseRow {
  name: string;
  muscles: string | null;
  dose: string;
  rest: string | null;
  /** The phone's second line. */
  line: string;
}

export interface PickDay {
  key: string;
  label: string;
  title: string;
  count: string;
  start: StartSessionBody;
}

export type TodayModel =
  | { kind: 'none' }
  | {
      kind: 'open';
      session: WorkoutSessionView;
      title: string;
      /** "From Coach Ana's plan · 5 exercises". */
      line: string;
      progress: ReturnType<typeof viewProgress>;
      startedLabel: string;
      href: string;
    }
  | {
      kind: 'done';
      summary: WorkoutSessionSummary;
      title: string;
      /** "46 min · 13 sets · 4,435 kg". */
      line: string;
      href: string;
    }
  | {
      kind: 'train';
      source: 'member' | 'coach';
      title: string;
      /** Rendered as `{lead} <strong>{planName}</strong>.` */
      lead: string;
      planName: string;
      /** The plan's own label for the dashboard ("Beginner Muscle", "Coach Ana's plan"). */
      planLabel: string;
      chips: string[];
      phoneLine: string;
      minutes: number | null;
      start: StartSessionBody;
      planHref: string;
      adjustHref: string | null;
      exercises: TodayExerciseRow[];
    }
  | {
      kind: 'rest';
      source: 'member' | 'coach';
      title: 'Rest day';
      lead: string;
      planName: string;
      planLabel: string;
      nextHref: string | null;
      next: { label: string; title: string } | null;
    }
  | {
      kind: 'pick';
      planName: string;
      lead: string;
      days: PickDay[];
    };

export const SESSION_HREF = '/portal/workouts/session';

function exerciseRows(
  exercises: readonly SessionExercise[],
  withRest: boolean,
): TodayExerciseRow[] {
  return exercises.map((e) => ({
    name: e.name,
    muscles: e.muscles,
    dose: dose(e),
    rest: withRest ? restLabel(e.restSeconds) : null,
    line: withRest ? doseLine(e) : dose(e),
  }));
}

function openLine(session: WorkoutSessionView): string {
  const from =
    session.source === 'COACH_PLAN'
      ? `From ${session.coach === null ? 'your coach' : `Coach ${session.coach.firstName}`}'s plan`
      : session.planName;
  return `${from} · ${exerciseCount(session.exercises.length)}`;
}

function doneLine(summary: WorkoutSessionSummary): string {
  const sets = `${summary.setsDone} ${summary.setsDone === 1 ? 'set' : 'sets'}`;
  const volume = summary.volumeKg > 0 ? ` · ${kgText(summary.volumeKg)}` : '';
  return `${durationText(summary.durationMinutes)} · ${sets}${volume}`;
}

/**
 * The hub's Today card, whole: an open workout first (In progress), then one
 * finished today (Done), then the day from whichever plan drives Today.
 */
export function todayModel(
  home: Pick<WorkoutsHome, 'plans' | 'coachPlan' | 'session' | 'recent'>,
  today: CivilDate,
): TodayModel {
  if (home.session !== null) {
    return {
      kind: 'open',
      session: home.session,
      title: home.session.dayTitle,
      line: openLine(home.session),
      progress: viewProgress(home.session),
      startedLabel: `Started ${gymClock12(home.session.startedAt)}`,
      href: SESSION_HREF,
    };
  }

  const finished = finishedOn(home.recent, today);
  if (finished !== null) {
    return {
      kind: 'done',
      summary: finished,
      title: finished.dayTitle,
      line: doneLine(finished),
      href: summaryHref(finished.id),
    };
  }

  const source = todaySource(home);
  const weekday = weekdayOf(today);

  if (source.kind === 'member') {
    const view = todayView(source.plan, today);
    if (view.kind === 'train') {
      return {
        kind: 'train',
        source: 'member',
        title: view.title,
        lead: view.lead,
        planName: view.planName,
        planLabel: view.planName,
        chips: view.chips,
        phoneLine: view.phoneLine,
        minutes: view.day.minutes,
        start: { source: 'MEMBER_PLAN', planId: source.plan.id, weekday },
        planHref: view.startHref,
        adjustHref: view.adjustHref,
        exercises: exerciseRows(view.day.exercises, true),
      };
    }
    if (view.kind === 'rest') {
      return {
        kind: 'rest',
        source: 'member',
        title: 'Rest day',
        lead: view.lead,
        planName: view.planName,
        planLabel: view.planName,
        nextHref: view.startHref,
        next: view.next === null ? null : { label: view.next.label, title: view.next.day.title },
      };
    }
    return { kind: 'none' };
  }

  if (source.kind === 'coach') {
    const plan = source.plan;
    const days = coachDays(plan);
    const name = coachName(plan);
    const label = coachPlanTitle(plan);
    const decision = coachToday(plan, weekday);

    if (decision.kind === 'pick') {
      return {
        kind: 'pick',
        planName: label,
        lead: `${label} does not name a weekday for its days, so pick the one you are doing.`,
        days: days.map((d) => ({
          key: `c:${d.index}`,
          label: plan.plan.days[d.index]?.day ?? d.kicker,
          title: d.title,
          count: d.count,
          start: d.start,
        })),
      };
    }

    if (decision.kind === 'train') {
      const day = days[decision.dayIndex];
      const raw = plan.plan.days[decision.dayIndex];
      if (day !== undefined && raw !== undefined) {
        const count = exerciseCount(raw.exercises.length);
        return {
          kind: 'train',
          source: 'coach',
          title: day.title,
          lead: `Day ${day.index + 1} of the plan from`,
          planName: name,
          planLabel: label,
          chips: [count],
          phoneLine: `${count} · ${label}`,
          minutes: null,
          start: day.start,
          planHref: coachDayHref(day.index),
          adjustHref: null,
          exercises: exerciseRows(sessionExercisesFromCoachDay(raw), false),
        };
      }
    }

    const next = decision.kind === 'rest' ? decision.next : null;
    const nextDay = next === null ? undefined : days[next.dayIndex];
    return {
      kind: 'rest',
      source: 'coach',
      title: 'Rest day',
      lead:
        next === null || nextDay === undefined
          ? 'No session today in the plan from'
          : `Next session: ${WEEKDAY_LONG[next.weekday]} — ${nextDay.title}, from`,
      planName: name,
      planLabel: label,
      nextHref: nextDay === undefined ? null : coachDayHref(nextDay.index),
      next:
        next === null || nextDay === undefined
          ? null
          : { label: WEEKDAY_LONG[next.weekday] ?? '', title: nextDay.title },
    };
  }

  return { kind: 'none' };
}

export interface DashboardCardCopy {
  heading: string;
  planLabel: string;
  title: string;
  meta: string;
  href: string;
  cta: string;
}

/** The dashboard's compact card, or null when there is nothing to show. */
export function dashboardCard(model: TodayModel): DashboardCardCopy | null {
  switch (model.kind) {
    case 'open':
      return {
        heading: 'Workout in progress',
        planLabel: model.session.planName,
        title: model.title,
        meta: `${model.progress.complete} of ${model.progress.total} exercises done`,
        href: model.href,
        cta: 'Continue',
      };
    case 'done':
      return {
        heading: 'Done today',
        planLabel: model.summary.planName,
        title: model.title,
        meta: model.line,
        href: model.href,
        cta: 'View summary',
      };
    case 'train':
      return {
        heading: model.source === 'member' ? "Today's AI workout" : "Today's workout",
        planLabel: model.planLabel,
        title: model.title,
        meta:
          model.minutes === null
            ? (model.chips[0] ?? '')
            : `${model.chips[0] ?? ''} · about ${model.minutes} min`,
        href: model.planHref,
        cta: 'Start',
      };
    case 'rest':
      if (model.next === null || model.nextHref === null) return null;
      return {
        heading: model.source === 'member' ? "Today's AI workout" : "Today's workout",
        planLabel: model.planLabel,
        title: 'Rest day',
        meta: `Next ${model.next.label}: ${model.next.title}`,
        href: model.nextHref,
        cta: 'Open plan',
      };
    case 'pick':
      return {
        heading: "Today's workout",
        planLabel: model.planName,
        title: 'Pick a day',
        meta: `${model.days.length} ${model.days.length === 1 ? 'day' : 'days'} to choose from`,
        href: '/portal/workouts',
        cta: 'Choose',
      };
    case 'none':
      return null;
  }
}
