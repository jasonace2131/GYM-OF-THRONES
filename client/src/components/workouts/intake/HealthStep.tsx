import { WORKOUT_EASY_ON } from '@got/shared';
import { healthFlag, type IntakeAction, type IntakeState } from '@/lib/workouts/intake';
import { EASY_ON_LABEL, PARQ_QUESTIONS, SAFETY_LINE } from '@/lib/workouts/labels';
import { cn } from '@/lib/utils';
import { IconWarning } from '../icons';
import { Notice, ToggleChip, YesNo } from '../ui';
import { StepHeading, StepProblem } from './StepHeading';

/**
 * Step 4 — the seven PAR-Q+ questions, "Go easy on", the gentle notice, and
 * consent. The answers are read from and written to the reducer's `parq`
 * only; nothing on this step touches the wire.
 */
export function HealthStep({
  state,
  problem,
  dispatch,
}: {
  state: IntakeState;
  problem: string | null;
  dispatch: (action: IntakeAction) => void;
}) {
  const anyYes = healthFlag(state);
  return (
    <div className="flex flex-col gap-[18px]">
      <StepHeading
        title="Quick health check"
        sub="Seven yes-or-no questions, based on the standard PAR-Q+ screening. Your answers only decide how gentle the plan is — they are not a diagnosis."
      />
      <ol className="m-0 flex list-none flex-col overflow-hidden rounded-xl border border-border p-0">
        {PARQ_QUESTIONS.map((question, i) => {
          const yes = state.parq[i] === true;
          const id = `wk-parq-${i + 1}`;
          return (
            <li
              key={id}
              className={cn(
                // Phones: Yes/No under the question, so the question keeps the full width.
                'grid grid-cols-1 items-center gap-2 border-b @md:grid-cols-[minmax(0,1fr)_auto] @md:gap-2.5 border-[rgba(26,26,26,0.07)] px-3 py-2.5 last:border-b-0 @2xl:grid-cols-[26px_minmax(0,1fr)_auto] @2xl:gap-3 @2xl:px-3.5',
                yes ? 'bg-[#fffaf0]' : 'bg-card',
              )}
            >
              <span className="hidden text-[12.5px] font-bold text-ink-3 @2xl:block" aria-hidden>
                {i + 1}
              </span>
              <span id={id} className="text-[13.5px] leading-[1.4] @2xl:text-[14px]">
                {question}
              </span>
              <YesNo
                className="justify-self-start @md:justify-self-auto"
                value={yes}
                labelledBy={id}
                onChange={(value) => dispatch({ type: 'parq', index: i, value })}
              />
            </li>
          );
        })}
      </ol>
      <div className="flex flex-col gap-2.5">
        <span className="text-[14px] font-semibold" id="wk-easy-l">
          Go easy on <span className="font-normal text-ink-3">· optional</span>
        </span>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="wk-easy-l">
          {WORKOUT_EASY_ON.map((area) => (
            <ToggleChip
              key={area}
              pressed={state.easyOn.includes(area)}
              onClick={() => dispatch({ type: 'toggleEasyOn', area })}
              className="h-10 pointer-coarse:h-11"
            >
              {EASY_ON_LABEL[area]}
            </ToggleChip>
          ))}
        </div>
      </div>
      {anyYes ? (
        <Notice tone="warn" role="status" icon={<IconWarning />}>
          <strong>Your plan will stay gentle.</strong> Because you answered yes, please talk to a
          doctor before training hard, and let the front desk know. This planner gives general
          fitness guidance, not medical advice.
        </Notice>
      ) : null}
      <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-[#f7f6f3] px-4 py-3.5">
        <input
          type="checkbox"
          checked={state.consent}
          onChange={(e) => dispatch({ type: 'consent', value: e.target.checked })}
          className="mt-px h-5 w-5 shrink-0 accent-[var(--gold)]"
        />
        <span className="text-[13.5px] leading-[1.5] text-[color:var(--p-ink)]">
          Send my answers to Google Gemini to draft this plan. The gym never sends my name, email or
          member code, and sends my health answers only as “keep it gentle”.
        </span>
      </label>
      <StepProblem problem={problem} />
      <p className="m-0 text-[12.5px] leading-[1.45] text-ink-3">{SAFETY_LINE}</p>
    </div>
  );
}
