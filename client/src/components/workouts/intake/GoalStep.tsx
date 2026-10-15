import { WORKOUT_GOALS, WORKOUT_LIMITS } from '@got/shared';
import type { IntakeAction, IntakeState } from '@/lib/workouts/intake';
import { GOAL_LABEL } from '@/lib/workouts/labels';
import { RadioCard } from '../ui';
import { StepHeading, StepProblem } from './StepHeading';

/** Step 1 — What's your main goal? */
export function GoalStep({
  state,
  problem,
  dispatch,
}: {
  state: IntakeState;
  problem: string | null;
  dispatch: (action: IntakeAction) => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        title="What’s your main goal?"
        sub="Pick one. The AI builds the whole week around it."
      />
      <div
        role="radiogroup"
        aria-label="Main goal"
        className="grid grid-cols-2 gap-3 @2xl:grid-cols-3"
      >
        {WORKOUT_GOALS.map((goal) => (
          <RadioCard
            key={goal}
            checked={state.goal === goal}
            title={GOAL_LABEL[goal].title}
            sub={GOAL_LABEL[goal].sub}
            onClick={() => dispatch({ type: 'goal', goal })}
          />
        ))}
      </div>
      <StepProblem problem={problem} />
      <div className="flex flex-col gap-2">
        <label htmlFor="wk-own-words" className="text-[14px] font-semibold">
          In your own words <span className="font-normal text-ink-3">· optional</span>
        </label>
        <textarea
          id="wk-own-words"
          rows={3}
          value={state.goalNotes}
          maxLength={WORKOUT_LIMITS.goalNotesMax + 20}
          onChange={(e) => dispatch({ type: 'goalNotes', value: e.target.value })}
          placeholder="e.g. I want to do 10 full push-ups by December"
          className="resize-none rounded-[10px] border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3.5 py-3 text-[14.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        />
        <span className="text-[12.5px] text-ink-3">
          Keep health details for the health check in step 4 — this box is sent to the AI as
          written.
        </span>
      </div>
    </div>
  );
}
