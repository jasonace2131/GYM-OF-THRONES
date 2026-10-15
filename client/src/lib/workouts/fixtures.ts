import {
  sessionExercisesFromMemberDay,
  type CoachPlanInWorkouts,
  type LoggedSet,
  type MemberPlanBody,
  type MemberPlanDay,
  type MemberWorkoutPlanView,
  type MyBookingWire,
  type MyCheckInSummary,
  type SessionExerciseView,
  type WorkoutDraftView,
  type WorkoutIntakeSummary,
  type WorkoutSessionSummary,
  type WorkoutSessionView,
  type WorkoutsHome,
} from '@got/shared';
import type { CivilDate } from '@/lib/gymTime';

/**
 * Test fixtures shaped like the mockups: the "Beginner Muscle" plan on
 * Mon · Wed · Sat, a Tuesday Spin class, a Monday check-in, and Wednesday
 * September 30, 2026 as "today". Shared by the lib tests; never imported by
 * a page.
 */

export const TODAY = '2026-09-30' as CivilDate; // a Wednesday

const ex = (
  name: string,
  muscles: string,
  sets: number,
  reps: string,
  restSeconds: number,
  notes?: string,
) =>
  notes === undefined
    ? { name, muscles, sets, reps, restSeconds }
    : { name, muscles, sets, reps, restSeconds, notes };

export const DAY_A: MemberPlanDay = {
  weekday: 1,
  title: 'Full body A',
  focus: 'Legs, chest and back',
  minutes: 45,
  warmUp: '5 min easy bike, then 10 bodyweight squats and 10 arm circles each way.',
  coolDown: '3 min slow walk, then hamstring and chest stretches, 30 s each.',
  exercises: [
    ex('Goblet squat', 'Legs · glutes', 3, '10-12', 90, 'Hold one dumbbell against your chest.'),
    ex('Dumbbell bench press', 'Chest · shoulders · triceps', 3, '8-10', 90),
    ex('Lat pulldown', 'Back · biceps', 3, '10-12', 75),
    ex('Dumbbell Romanian deadlift', 'Hamstrings · glutes · lower back', 3, '10', 90),
    ex('Plank', 'Core', 3, '30 s', 45),
  ],
};

export const DAY_B: MemberPlanDay = {
  weekday: 3,
  title: 'Full body B',
  focus: 'Legs, back and shoulders',
  minutes: 45,
  warmUp: '5 min easy row, then 10 glute bridges and 10 band pull-aparts.',
  coolDown: '3 min slow walk, then quad and upper-back stretches, 30 s each.',
  exercises: [
    ex('Leg press', 'Legs · glutes', 3, '12', 90, 'Do not lock your knees at the top.'),
    ex('Seated cable row', 'Mid-back · biceps', 3, '10-12', 75),
    ex('Dumbbell shoulder press', 'Shoulders · triceps', 3, '10', 75),
    ex('Walking lunge', 'Legs · glutes · balance', 2, '10 each', 90),
    ex('Dead bug', 'Core', 3, '8 each', 45),
  ],
};

export const DAY_C: MemberPlanDay = {
  weekday: 6,
  title: 'Full body C',
  focus: 'Whole body and cardio',
  minutes: 50,
  warmUp: '5 min easy bike, then 10 hip hinges with a dowel and 10 wall push-ups.',
  coolDown: '3 min easy pedalling, then hip and calf stretches, 30 s each.',
  exercises: [
    ex('Trap-bar deadlift', 'Legs · back · grip', 3, '6-8', 120),
    ex('Incline push-up', 'Chest · triceps · core', 3, '8-12', 60),
    ex('Chest-supported row', 'Upper back · rear shoulders', 3, '10', 75),
    ex('Step-up', 'Legs · glutes · balance', 2, '10 each', 60),
    ex('Bike intervals', 'Heart and lungs', 8, '30 s hard', 60),
  ],
};

export const PLAN_BODY: MemberPlanBody = {
  summary:
    'Three full-body sessions on Monday, Wednesday and Saturday evenings — the days you said you are free.',
  days: [DAY_A, DAY_B, DAY_C],
  guidance: [
    { title: 'Sleep', body: '7–9 hours. Muscle is rebuilt while you rest, not while you train.' },
    { title: 'Protein', body: 'Some at every meal — a palm-sized portion.' },
    { title: 'Water', body: 'Drink before, during and after training — more on hot days.' },
    { title: 'Rest days', body: 'A 20-minute walk on Thursday helps soreness pass sooner.' },
  ],
};

export const INTAKE: WorkoutIntakeSummary = {
  goal: 'MUSCLE',
  experience: 'NEW',
  weekdays: [1, 3, 6],
  sessionMinutes: 45,
  timeOfDay: 'EVENING',
  healthFlag: false,
  easyOn: ['KNEES'],
  use: { measurements: true, attendance: true, bookings: true },
};

export const PLAN: MemberWorkoutPlanView = {
  id: 'plan-1',
  name: 'Beginner Muscle',
  isActive: true,
  intake: INTAKE,
  plan: PLAN_BODY,
  source: 'AI',
  createdAt: '2026-09-25T10:00:00.000Z',
  updatedAt: '2026-09-28T02:00:00.000Z',
};

export const PLAN_2: MemberWorkoutPlanView = {
  ...PLAN,
  id: 'plan-2',
  name: 'Exam-week Express',
  isActive: false,
  intake: { ...INTAKE, goal: 'GENERAL', weekdays: [2, 5], sessionMinutes: 30 },
  plan: {
    ...PLAN_BODY,
    days: [
      { ...DAY_A, weekday: 2 },
      { ...DAY_B, weekday: 5 },
    ],
  },
  updatedAt: '2026-09-12T02:00:00.000Z',
};

/** A visit on Monday Sep 28 (this week) and one the week before. */
export const CHECKINS: MyCheckInSummary = {
  thisMonth: 9,
  allTime: 40,
  avgPerWeek: 2.1,
  currentStreakWeeks: 3,
  longestStreakWeeks: 5,
  days: [
    { date: '2026-09-21' as CivilDate, count: 1 },
    { date: '2026-09-28' as CivilDate, count: 1 },
  ],
};

/** Spin on Tuesday Sep 29 at 6:00 PM Manila (10:00Z). */
export const SPIN: MyBookingWire = {
  bookingId: 'b1',
  status: 'BOOKED',
  bookedAt: '2026-09-20T00:00:00.000Z',
  promotedAt: null,
  attendedAt: null,
  cancelledAt: null,
  waitlistPosition: null,
  cancelledBy: null,
  removalReason: null,
  addedByStaff: false,
  session: {
    id: 's1',
    title: 'Spin',
    description: null,
    coachId: 'c1',
    coachName: 'Mia Santos',
    startsAt: '2026-09-29T10:00:00.000Z',
    endsAt: '2026-09-29T11:00:00.000Z',
    businessDate: '2026-09-29',
    capacity: 12,
    bookedCount: 8,
    seatsLeft: 4,
    isFull: false,
    waitlistCount: 0,
    cancelledAt: null,
    cancelReason: null,
  },
};

export const QUOTA = {
  used: 3,
  limit: 8,
  remaining: 5,
  resetsAt: '2026-09-30T16:00:00.000Z',
};

export const HOME: WorkoutsHome = {
  plans: [PLAN, PLAN_2],
  draft: null,
  quota: QUOTA,
  lastIntake: INTAKE,
  coachPlan: null,
  session: null,
  recent: [],
};

// ── Workout sessions (feat/workout-sessions) ─────────────────────────────

/** Coach Ana's plan, its days labelled Monday · Wednesday · Friday. */
export const COACH_PLAN: CoachPlanInWorkouts = {
  plan: {
    summary: 'Three strength days to build a base. Add weight when every set feels easy.',
    days: [
      {
        day: 'Monday',
        focus: 'Lower body',
        exercises: [
          { name: 'Back squat', sets: 4, reps: '6-8' },
          { name: 'Romanian deadlift', sets: 3, reps: '8-10', notes: 'Soft knees, flat back.' },
        ],
      },
      {
        day: 'Wednesday',
        focus: 'Upper body',
        exercises: [
          { name: 'Bench press', sets: 4, reps: '6-8' },
          { name: 'Seated cable row', sets: 3, reps: '10-12' },
          { name: 'Plank', sets: 3, reps: '30s' },
        ],
      },
      {
        day: 'Friday',
        focus: 'Full body',
        exercises: [{ name: 'Trap-bar deadlift', sets: 3, reps: '5' }],
      },
    ],
  },
  coach: { firstName: 'Ana', lastName: 'Reyes' },
  updatedAt: '2026-09-27T03:00:00.000Z',
  isActive: false,
  weekdays: [1, 3, 5],
};

/** A coach plan whose days name no weekday — Today asks which one. */
export const COACH_PLAN_UNLABELLED: CoachPlanInWorkouts = {
  ...COACH_PLAN,
  plan: {
    ...COACH_PLAN.plan,
    days: COACH_PLAN.plan.days.map((day, i) => ({ ...day, day: `Day ${i + 1}` })),
  },
  weekdays: [null, null, null],
};

const LAST_TIME: (SessionExerciseView['lastTime'] | null)[] = [
  {
    date: '2026-09-23',
    sets: [
      { weightKg: 80, reps: 12 },
      { weightKg: 80, reps: 12 },
      { weightKg: 80, reps: 11 },
    ],
  },
  {
    date: '2026-09-23',
    sets: [
      { weightKg: 35, reps: 12 },
      { weightKg: 35, reps: 12 },
    ],
  },
  { date: '2026-09-23', sets: [{ weightKg: 12, reps: 10 }] },
  {
    date: '2026-09-23',
    sets: [
      { weightKg: null, reps: 10 },
      { weightKg: null, reps: 10 },
    ],
  },
  null,
];
const BEST_KG: (number | null)[] = [80, 35, 12, null, null];

/** "Full body B" (PhoneSession.dc.html): leg press and cable row done, press 1 of 3. */
export const SESSION_EXERCISES: SessionExerciseView[] = sessionExercisesFromMemberDay(DAY_B).map(
  (exercise, i) => ({ ...exercise, lastTime: LAST_TIME[i] ?? null, bestKg: BEST_KG[i] ?? null }),
);

const logged = (
  exerciseIndex: number,
  setIndex: number,
  weightKg: number | null,
  reps: number,
  minute: number,
): LoggedSet => ({
  exerciseIndex,
  setIndex,
  weightKg,
  reps,
  completedAt: `2026-09-30T10:${String(minute).padStart(2, '0')}:00.000Z`,
});

export const SESSION: WorkoutSessionView = {
  id: 'sess-1',
  source: 'MEMBER_PLAN',
  planName: 'Beginner Muscle',
  coach: null,
  dayTitle: 'Full body B',
  weekday: 3,
  businessDate: '2026-09-30',
  exercises: SESSION_EXERCISES,
  sets: [
    logged(0, 0, 80, 12, 15),
    logged(0, 1, 80, 12, 18),
    logged(0, 2, 80, 11, 21),
    logged(1, 0, 35, 12, 24),
    logged(1, 1, 35, 12, 26),
    logged(1, 2, 37.5, 10, 28),
    logged(2, 0, 14, 10, 30),
  ],
  // 6:12 PM in Manila.
  startedAt: '2026-09-30T10:12:00.000Z',
  finishedAt: null,
  feeling: null,
};

/** PhoneFinish.dc.html: 13 sets, 5 of 5, 4,435 kg, one new best. */
export const SUMMARY: WorkoutSessionSummary = {
  id: 'sess-1',
  source: 'MEMBER_PLAN',
  planName: 'Beginner Muscle',
  dayTitle: 'Full body B',
  businessDate: '2026-09-30',
  startedAt: '2026-09-30T10:12:00.000Z',
  finishedAt: '2026-09-30T10:58:00.000Z',
  durationMinutes: 46,
  setsDone: 13,
  exercisesDone: 5,
  exerciseCount: 5,
  volumeKg: 4435,
  bests: [{ exerciseName: 'Dumbbell shoulder press', weightKg: 14, reps: 10, previousKg: 12 }],
  perExercise: [
    { name: 'Leg press', setsDone: 3, plannedSets: 3, top: { weightKg: 80, reps: 12 } },
    { name: 'Seated cable row', setsDone: 3, plannedSets: 3, top: { weightKg: 37.5, reps: 10 } },
    {
      name: 'Dumbbell shoulder press',
      setsDone: 3,
      plannedSets: 3,
      top: { weightKg: 14, reps: 10 },
    },
    { name: 'Walking lunge', setsDone: 2, plannedSets: 2, top: { weightKg: null, reps: 10 } },
    { name: 'Dead bug', setsDone: 2, plannedSets: 3, top: { weightKg: null, reps: 8 } },
  ],
  feeling: null,
};

/** Monday's session from the coach's plan (PhoneHubCoach.dc.html "Recent workouts"). */
export const SUMMARY_MONDAY: WorkoutSessionSummary = {
  ...SUMMARY,
  id: 'sess-0',
  source: 'COACH_PLAN',
  planName: "Coach Ana's plan",
  dayTitle: 'Full body A',
  businessDate: '2026-09-28',
  startedAt: '2026-09-28T10:00:00.000Z',
  finishedAt: '2026-09-28T10:48:00.000Z',
  durationMinutes: 48,
  setsDone: 15,
  volumeKg: 1980,
  bests: [],
};

export const DRAFT_RUNNING: WorkoutDraftView = {
  status: 'RUNNING',
  intake: INTAKE,
  plan: { summary: PLAN_BODY.summary, days: [DAY_A], guidance: null },
  error: null,
  startedAt: '2026-09-30T08:00:00.000Z',
  firstDayMs: 3_100,
};

export const DRAFT_READY: WorkoutDraftView = {
  status: 'READY',
  intake: INTAKE,
  plan: { summary: PLAN_BODY.summary, days: PLAN_BODY.days, guidance: PLAN_BODY.guidance },
  error: null,
  startedAt: '2026-09-30T08:00:00.000Z',
  firstDayMs: 3_100,
};
