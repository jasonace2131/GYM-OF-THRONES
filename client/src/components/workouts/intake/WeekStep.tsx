import { WORKOUT_SESSION_MINUTES, WORKOUT_TIMES_OF_DAY } from '@got/shared';
import type { IntakeAction, IntakeState } from '@/lib/workouts/intake';
import { TIME_LABEL, WEEKDAY_SHORT, WEEK_ORDER } from '@/lib/workouts/labels';
import { IconCalendar } from '../icons';
import { Notice, RadioPill, ToggleChip } from '../ui';
import { StepHeading, StepProblem } from './StepHeading';

function daysNote(count: number): string {
  if (count === 0) return 'Pick at least one day.';
  return `${count} ${count === 1 ? 'day' : 'days'} picked. The AI spreads the work so no muscle is trained two days running.`;
}

/** Step 3 — Your week: days, minutes, time of day, and the booked-class hint. */
export function WeekStep({
  state,
  bookingHint,
  problem,
  dispatch,
}: {
  state: IntakeState;
  /** "Spin on Tuesdays at 6:00 PM", or null with no booking. */
  bookingHint: string | null;
  problem: string | null;
  dispatch: (action: IntakeAction) => void;
}) {
  return (
    <div className="flex flex-col gap-[22px]">
      <StepHeading
        title="Your week"
        sub="The AI places each session on a day you’re free and inside the gym’s hours for that day."
      />
      <div className="flex flex-col gap-2.5">
        <span className="text-[14px] font-semibold" id="wk-days-l">
          Which days can you train?
        </span>
        <div
          // Seven 44px chips: 7 columns from a 24rem (384px) container, ~416px of
          // screen; anything narrower wraps them 4 + 3.
          className="grid grid-cols-4 gap-1.5 @min-[24rem]:grid-cols-7 @md:gap-2"
          role="group"
          aria-labelledby="wk-days-l"
        >
          {WEEK_ORDER.map((weekday) => (
            <ToggleChip
              key={weekday}
              pressed={state.weekdays.includes(weekday)}
              onClick={() => dispatch({ type: 'toggleDay', weekday })}
              className="min-w-0 rounded-[10px] px-0 text-[13px] @md:text-[14px]"
            >
              {WEEKDAY_SHORT[weekday]}
            </ToggleChip>
          ))}
        </div>
        <span className="text-[13px] text-ink-2">{daysNote(state.weekdays.length)}</span>
      </div>
      <StepProblem problem={problem} />
      <div className="flex flex-col gap-2.5">
        <span className="text-[14px] font-semibold" id="wk-len-l">
          How long per session?
        </span>
        <div
          role="radiogroup"
          aria-labelledby="wk-len-l"
          className="grid grid-cols-4 gap-2 @md:flex"
        >
          {WORKOUT_SESSION_MINUTES.map((minutes) => (
            <RadioPill
              key={minutes}
              checked={state.sessionMinutes === minutes}
              onClick={() => dispatch({ type: 'minutes', value: minutes })}
              className="px-2 @md:px-[18px]"
            >
              {minutes} min
            </RadioPill>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2.5">
        <span className="text-[14px] font-semibold" id="wk-time-l">
          When do you usually come in?
        </span>
        <div
          role="radiogroup"
          aria-labelledby="wk-time-l"
          className="grid grid-cols-3 gap-2 @md:flex"
        >
          {WORKOUT_TIMES_OF_DAY.map((time) => (
            <RadioPill
              key={time}
              checked={state.timeOfDay === time}
              onClick={() => dispatch({ type: 'timeOfDay', value: time })}
              className="px-2 @md:px-[18px]"
            >
              {TIME_LABEL[time]}
            </RadioPill>
          ))}
        </div>
      </div>
      {bookingHint === null || !state.use.bookings ? null : (
        <Notice tone="info" icon={<IconCalendar />}>
          You’re booked into <strong>{bookingHint}</strong>. The AI keeps that day for cardio and
          won’t stack leg work the day after.
        </Notice>
      )}
    </div>
  );
}
