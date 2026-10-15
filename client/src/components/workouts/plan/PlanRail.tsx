import type { MemberPlanBody } from '@got/shared';
import { weekRows } from '@/lib/workouts/planView';
import { cn } from '@/lib/utils';
import { IconShield } from '../icons';
import { guidanceGlyph } from '../TipCard';
import { KickerHeading, Panel } from '../ui';

/** Why this plan · Your week · Wellness guidance · Train safely. */
export function PlanRail({
  plan,
  classes,
}: {
  plan: MemberPlanBody;
  /** Weekday → "Spin class · 6:00 PM (booked)". */
  classes: Record<number, string>;
}) {
  return (
    <aside className="flex flex-col gap-4 @3xl:gap-5">
      <Panel
        aria-labelledby="wk-why-h"
        className="flex flex-col gap-3 px-4 py-4 @md:px-[22px] @md:py-5"
      >
        <KickerHeading id="wk-why-h">Why this plan</KickerHeading>
        <p className="m-0 text-[14px] leading-[1.6] whitespace-pre-wrap text-[color:var(--p-ink)]">
          {plan.summary}
        </p>
      </Panel>

      <Panel
        aria-labelledby="wk-week-h"
        className="flex flex-col gap-2.5 px-4 py-4 @md:px-[22px] @md:py-5"
      >
        <KickerHeading id="wk-week-h" className="mb-1">
          Your week
        </KickerHeading>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {weekRows(plan, classes).map((row) => (
            <li
              key={row.weekday}
              className="grid grid-cols-[38px_10px_minmax(0,1fr)] items-center gap-2.5 text-[13.5px]"
            >
              <span className="font-bold text-[color:var(--p-ink)]">{row.day}</span>
              <span
                aria-hidden
                className={cn(
                  'h-2.5 w-2.5 rounded-full',
                  row.kind === 'train'
                    ? 'bg-gold'
                    : row.kind === 'class'
                      ? 'bg-info'
                      : 'border-2 border-[#c7c3bc]',
                )}
              />
              <span className={row.kind === 'rest' ? 'text-ink-3' : 'text-foreground'}>
                {row.what}
              </span>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        aria-labelledby="wk-well-h"
        className="flex flex-col gap-3.5 px-4 py-4 @md:px-[22px] @md:py-5"
      >
        <KickerHeading id="wk-well-h">Wellness guidance</KickerHeading>
        {plan.guidance.map((tip) => {
          const glyph = guidanceGlyph(tip.title);
          return (
            <div key={tip.title} className="flex items-start gap-3">
              <span
                className={cn(
                  'flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full',
                  glyph.className,
                )}
                aria-hidden
              >
                {glyph.icon}
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="text-[14px] font-semibold">{tip.title}</span>
                <span className="text-[13px] leading-[1.5] text-ink-2">{tip.body}</span>
              </div>
            </div>
          );
        })}
        <p className="m-0 border-t border-[rgba(26,26,26,0.08)] pt-2.5 text-[12.5px] text-ink-3">
          General guidance — not medical or diet advice.
        </p>
      </Panel>

      <section
        aria-labelledby="wk-safe-h"
        className="flex flex-col gap-2 rounded-[14px] border border-[#efd9a8] bg-warn-bg px-5 py-[18px] text-[#5c3f0f]"
      >
        <h2 id="wk-safe-h" className="m-0 flex items-center gap-2 text-[14px] font-bold">
          <IconShield size={17} />
          Train safely
        </h2>
        <p className="m-0 text-[13px] leading-[1.55]">
          Stop and tell staff if you feel chest pain, dizziness or sharp joint pain. This plan is
          general fitness guidance, not medical advice or a diagnosis.
        </p>
      </section>
    </aside>
  );
}
