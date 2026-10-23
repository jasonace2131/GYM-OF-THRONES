import type { WorkoutAiQuotaView } from '@got/shared';
import type { AccountBody } from '@/lib/workouts/body';
import { summaryRows, whatAiSees, type GymFacts, type IntakeState } from '@/lib/workouts/intake';
import { canSpend, generateNote } from '@/lib/workouts/quota';
import { IconCheck, IconLock, IconSparkle } from '../icons';
import { KickerHeading, Panel } from '../ui';

/**
 * YOUR PLAN SO FAR + WHAT THE AI SEES. A column on desktop; on a phone the
 * same content sits inside a collapsed `<details>` strip under the form.
 */
export function IntakeRail({
  state,
  facts,
  quota,
  body,
}: {
  state: IntakeState;
  facts: GymFacts;
  quota: WorkoutAiQuotaView | null;
  /** The account's height and weight, for the Body row. */
  body: AccountBody | null;
}) {
  const rows = summaryRows(state, body);
  const sees = whatAiSees(state, facts);
  return (
    <>
      <div className="hidden flex-col gap-[18px] @4xl:flex">
        <Panel aria-labelledby="wk-sum-h" className="flex flex-col gap-3.5 px-[22px] py-5">
          <KickerHeading id="wk-sum-h">Your plan so far</KickerHeading>
          <SummaryList rows={rows} />
        </Panel>
        <Panel aria-labelledby="wk-sees-h" className="flex flex-col gap-3 px-[22px] py-5">
          <KickerHeading id="wk-sees-h">What the AI sees</KickerHeading>
          <SeesList sees={sees} />
        </Panel>
        {quota === null ? null : (
          <div className="flex items-center gap-2.5 rounded-xl bg-warn-bg px-4 py-3.5 text-[13px] leading-[1.4] font-medium text-warn">
            <IconSparkle className="shrink-0" />
            <span>
              {canSpend(quota)
                ? `Generating ${generateNote(quota).replace(/^Uses/, 'uses')}. Your first day appears in a few seconds.`
                : `${generateNote(quota)}.`}
            </span>
          </div>
        )}
      </div>

      <details className="group rounded-[14px] border border-border bg-card shadow-[var(--p-shadow)] @4xl:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="text-[11.5px] font-bold tracking-[0.14em] text-ink-3 uppercase">
              Your plan so far
            </span>
            <span className="truncate text-[13px] text-ink-2">
              {rows
                .slice(0, 3)
                .map((r) => r[1])
                .join(' · ')}
            </span>
          </span>
          <span className="shrink-0 text-[12.5px] font-semibold text-gold-deep group-open:hidden">
            Show
          </span>
          <span className="hidden shrink-0 text-[12.5px] font-semibold text-gold-deep group-open:inline">
            Hide
          </span>
        </summary>
        <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
          <SummaryList rows={rows} />
          <div className="flex flex-col gap-3">
            <span className="text-[11.5px] font-bold tracking-[0.14em] text-ink-3 uppercase">
              What the AI sees
            </span>
            <SeesList sees={sees} />
          </div>
        </div>
      </details>
    </>
  );
}

function SummaryList({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] gap-x-3 gap-y-2.5 text-[13.5px]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-ink-3">{label}</dt>
          <dd className="m-0 font-semibold">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function SeesList({ sees }: { sees: string[] }) {
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-[9px] p-0 text-[13.5px] leading-[1.4] text-[color:var(--p-ink)]">
        {sees.map((line) => (
          <li key={line} className="flex items-start gap-[9px]">
            <IconCheck className="mt-px shrink-0 text-ok" size={16} strokeWidth={2.2} />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <div className="flex items-start gap-[9px] border-t border-[rgba(26,26,26,0.08)] pt-3 text-[13px] leading-[1.45] text-ink-2">
        <IconLock className="mt-px shrink-0" size={16} strokeWidth={1.8} />
        <span>
          Never sent: your name, email, member code, or your health answers word for word.
        </span>
      </div>
    </>
  );
}
