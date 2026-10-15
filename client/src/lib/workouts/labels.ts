import type {
  WorkoutAdjustPreset,
  WorkoutEasyOn,
  WorkoutExperience,
  WorkoutGoal,
  WorkoutTimeOfDay,
} from '@got/shared';

/**
 * The planner's words for the shared enums — the mockup's copy, in one place,
 * so the wizard, the hub, the plan header and the dashboard card cannot
 * disagree about what "SOME" experience is called.
 */

export const GOAL_LABEL: Record<WorkoutGoal, { title: string; sub: string; short: string }> = {
  MUSCLE: { title: 'Build muscle', sub: 'Add size and shape', short: 'Muscle' },
  FAT_LOSS: { title: 'Lose fat', sub: 'Lean out and keep your muscle', short: 'Fat Loss' },
  STRENGTH: { title: 'Get stronger', sub: 'Lift heavier on the big moves', short: 'Strength' },
  ENDURANCE: { title: 'Build endurance', sub: 'Last longer, recover faster', short: 'Endurance' },
  GENERAL: { title: 'General fitness', sub: 'Feel better, move better', short: 'Fitness' },
  SPORT: { title: 'Sport performance', sub: 'Train for a sport you play', short: 'Sport' },
};

export const LEVEL_LABEL: Record<
  WorkoutExperience,
  { title: string; sub: string; short: string; name: string }
> = {
  NEW: {
    title: 'New to lifting',
    sub: 'Less than 6 months of regular training. The plan teaches the basics first.',
    short: 'Beginner',
    name: 'Beginner',
  },
  SOME: {
    title: 'Some experience',
    sub: '6 months to 2 years. You know the main lifts.',
    short: 'Intermediate',
    name: 'Intermediate',
  },
  EXPERIENCED: {
    title: 'Experienced',
    sub: '2+ years. You train hard and track your weights.',
    short: 'Experienced',
    name: 'Advanced',
  },
};

export const TIME_LABEL: Record<WorkoutTimeOfDay, string> = {
  MORNING: 'Morning',
  AFTERNOON: 'Afternoon',
  EVENING: 'Evening',
};

export const EASY_ON_LABEL: Record<WorkoutEasyOn, string> = {
  KNEES: 'Knees',
  LOWER_BACK: 'Lower back',
  SHOULDERS: 'Shoulders',
  WRISTS: 'Wrists',
  NECK: 'Neck',
  HIPS: 'Hips',
};

export const PRESET_LABEL: Record<WorkoutAdjustPreset, string> = {
  SHORTER: 'Only 30 min',
  BUSY: 'Equipment’s busy',
  EASIER: 'Make it easier',
  HARDER: 'Make it harder',
  LOW_IMPACT: 'Low impact',
};

/** 0 = Sunday, like `OpeningHours.dayOfWeek` and `WorkoutIntake.weekdays`. */
export const WEEKDAY_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Monday-first, the order every week strip and day-chip row renders in. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** The seven PAR-Q+ questions. Rendered in the browser and NEVER sent. */
export const PARQ_QUESTIONS = [
  'Has a doctor said you have a heart condition or high blood pressure?',
  'Do you get chest pain at rest, in daily life, or when you exercise?',
  'In the past year, has dizziness made you lose balance, or have you fainted?',
  'Do you have another long-term medical condition?',
  'Do you take prescribed medicine for a long-term condition?',
  'Do you have a bone, joint or muscle problem that exercise could make worse?',
  'Has a doctor said you should only exercise with medical supervision?',
] as const;

export const SAFETY_LINE =
  'General fitness guidance only — not medical advice or diagnosis. Stop and tell staff if you feel chest pain, dizziness or sharp joint pain.';

/** "Mon · Wed · Sat", Monday-first whatever order the input came in. */
export function weekdayList(weekdays: readonly number[]): string {
  const picked = WEEK_ORDER.filter((d) => weekdays.includes(d));
  return picked.length === 0 ? 'None yet' : picked.map((d) => WEEKDAY_SHORT[d]).join(' · ');
}

/** "knees, lower back" — for a chip or a summary row. */
export function easyOnPhrase(areas: readonly WorkoutEasyOn[]): string {
  return areas.map((a) => EASY_ON_LABEL[a].toLowerCase()).join(', ');
}

/** The Save dialog's prefilled name: "Beginner Muscle". */
export function planNameFor(goal: WorkoutGoal, experience: WorkoutExperience): string {
  return `${LEVEL_LABEL[experience].name} ${GOAL_LABEL[goal].short}`;
}
