import Link from 'next/link';
import { WORKOUT_LIMITS } from '@got/shared';
import { BODY_COPY, accountBodyLine, goalChoice, type AccountBody } from '@/lib/workouts/body';
import type { IntakeAction, IntakeState } from '@/lib/workouts/intake';
import { GOAL_LABEL } from '@/lib/workouts/labels';
import { RadioCard } from '../ui';
import { StepHeading, StepProblem } from './StepHeading';
import { CharCounter } from '@/components/inputs/CharCounter';

/**
 * Step 1 — What's your main goal?
 *
 * `body` is the account's height and weight (`GET /me/profile`), or null when
 * it could not be read — then no reminder line, and every goal is offered.
 * Under BMI 18.5 "Lose fat" is not offered (owner, 2026-10-23); the API
 * refuses it too.
 */
export function GoalStep({
  state,
  problem,
  dispatch,
  body,
}: {
  state: IntakeState;
  problem: string | null;
  dispatch: (action: IntakeAction) => void;
  body: AccountBody | null;
}) {
  const { goals, hiddenNote } = goalChoice(body);
  return (
    <div className="flex flex-col gap-5">
      <StepHeading
        title="What’s your main goal?"
        sub="Pick one. The AI builds the whole week around it."
      />
      {body === null ? null : (
        <div className="flex flex-col gap-1 text-[13px] leading-[1.45]">
          <p className="m-0 text-ink-2">
            {accountBodyLine(body)}{' '}
            <Link
              href="/portal/account"
              className="font-semibold whitespace-nowrap text-gold-deep underline underline-offset-2"
            >
              {BODY_COPY.editLink}
            </Link>
          </p>
          {hiddenNote === null ? null : <p className="m-0 text-ink-3">{hiddenNote}</p>}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label="Main goal"
        className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2 @2xl:grid-cols-3"
      >
        {goals.map((goal) => (
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
          maxLength={WORKOUT_LIMITS.goalNotesMax}
          aria-describedby="wk-own-words-count"
          onChange={(e) => dispatch({ type: 'goalNotes', value: e.target.value })}
          placeholder="e.g. I want to do 10 full push-ups by December"
          className="resize-none rounded-[10px] border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3.5 py-3 text-[14.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
        />
        <CharCounter
          id="wk-own-words-count"
          value={state.goalNotes}
          max={WORKOUT_LIMITS.goalNotesMax}
        />
        <span className="text-[12.5px] text-ink-3">
          Keep health details for the health check in step 4 — this box is sent to the AI as
          written.
        </span>
      </div>
    </div>
  );
}
