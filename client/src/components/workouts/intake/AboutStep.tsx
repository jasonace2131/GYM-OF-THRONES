import { WORKOUT_EXPERIENCE, type WorkoutIntake } from '@got/shared';
import type { GymFacts, IntakeAction, IntakeState } from '@/lib/workouts/intake';
import { LEVEL_LABEL } from '@/lib/workouts/labels';
import { IconLock } from '../icons';
import { RadioCard, Switch } from '../ui';
import { StepHeading, StepProblem } from './StepHeading';

interface FactRow {
  key: keyof WorkoutIntake['use'];
  title: string;
  detail: string;
}

/** Step 2 — experience, and the three "use what the gym knows" switches. */
export function AboutStep({
  state,
  facts,
  problem,
  dispatch,
}: {
  state: IntakeState;
  facts: GymFacts;
  problem: string | null;
  dispatch: (action: IntakeAction) => void;
}) {
  const rows: FactRow[] = [
    {
      key: 'measurements',
      title: 'Your measurements',
      detail: facts.measurements ?? 'Nothing recorded yet — ask your coach at your next session',
    },
    {
      key: 'attendance',
      title: 'Your attendance',
      detail: facts.attendance ?? 'No visits in the last 30 days',
    },
    {
      key: 'bookings',
      title: 'Your class bookings',
      detail: facts.bookings ?? 'No classes booked in the next two weeks',
    },
  ];

  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        title="How experienced are you?"
        sub="Be honest — a plan that’s too hard is the one people quit."
      />
      <div
        role="radiogroup"
        aria-label="Experience"
        className="grid grid-cols-1 gap-3 @2xl:grid-cols-3"
      >
        {WORKOUT_EXPERIENCE.map((level) => (
          <RadioCard
            key={level}
            checked={state.experience === level}
            title={LEVEL_LABEL[level].title}
            sub={LEVEL_LABEL[level].sub}
            onClick={() => dispatch({ type: 'experience', experience: level })}
          />
        ))}
      </div>
      <StepProblem problem={problem} />
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-[16px] font-bold">Also use what the gym already knows</h3>
          <p className="m-0 text-[13.5px] text-ink-2">
            Switch off anything you’d rather the AI didn’t see.
          </p>
        </div>
        {rows.map((row) => (
          <div
            key={row.key}
            className="flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5"
          >
            <div className="flex grow flex-col gap-[3px]">
              <span className="text-[14.5px] font-semibold">{row.title}</span>
              <span className="text-[13px] text-ink-2">{row.detail}</span>
            </div>
            <Switch
              checked={state.use[row.key]}
              label={`Use ${row.title.toLowerCase()}`}
              onChange={(value) => dispatch({ type: 'use', key: row.key, value })}
            />
          </div>
        ))}
        <div className="flex items-center gap-3.5 rounded-xl border border-border bg-card px-4 py-3.5">
          <div className="flex grow flex-col gap-[3px]">
            <span className="text-[14.5px] font-semibold">Gym opening hours</span>
            <span className="text-[13px] text-ink-2">
              So every session fits when the gym is open
            </span>
          </div>
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-ink-3">
            <IconLock />
            Always used
          </span>
        </div>
      </div>
    </div>
  );
}
