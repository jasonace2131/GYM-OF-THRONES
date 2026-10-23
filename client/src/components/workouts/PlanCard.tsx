import Link from 'next/link';
import type { CoachPlanInWorkouts, MemberWorkoutPlanView } from '@got/shared';
import {
  COACH_PLAN_HREF,
  coachBadge,
  coachPlanMeta,
  coachPlanTitle,
} from '@/lib/workouts/coachPlan';
import { WEEKDAY_LONG, WEEK_ORDER } from '@/lib/workouts/labels';
import { dayDots, planMeta, savedLabel, shortDate } from '@/lib/workouts/planView';
import { cn } from '@/lib/utils';
import { IconPerson, IconSparkles, IconTrash } from './icons';
import { PlainButton, Tag } from './ui';

function daysLabel(weekdays: readonly number[]): string {
  const names = WEEK_ORDER.filter((d) => weekdays.includes(d)).map((d) => WEEKDAY_LONG[d]);
  if (names.length === 0) return 'No training days';
  if (names.length === 1) return `Trains ${names[0]}`;
  return `Trains ${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The badges of PhoneHubCoach.dc.html: 3px × 9px, 10.5px, wide tracking. */
const BADGE = 'gap-[5px] px-[9px] py-[3px] text-[11px]';

/** Open and Use this plan: 40px on a phone (44px to the touch), 36px from @md. */
const HIT = "relative after:absolute after:inset-x-0 after:-inset-y-0.5 after:content-['']";

const CARD =
  'flex flex-col gap-2.5 rounded-[14px] bg-card px-4 py-4 shadow-[var(--p-shadow)] @md:gap-3 @md:px-[22px] @md:py-5';

function Dots({ weekdays }: { weekdays: readonly number[] }) {
  return (
    <div className="hidden gap-[5px] @md:flex" aria-label={daysLabel(weekdays)}>
      {dayDots(weekdays).map((dot) => (
        <span
          key={dot.weekday}
          aria-hidden
          className={cn(
            'flex h-[26px] w-[26px] items-center justify-center rounded-md text-[11px] font-bold',
            dot.on ? 'bg-night text-gold-lit' : 'bg-paper-3 text-ink-3',
          )}
        >
          {dot.letter}
        </span>
      ))}
    </div>
  );
}

function Footer({
  note,
  canUse,
  busy,
  openHref,
  onUse,
  deleteLabel,
  onDelete,
}: {
  note: string;
  canUse: boolean;
  busy: boolean;
  openHref: string;
  onUse: () => void;
  /** Present on a member's own plans only — a coach's plan is not theirs to delete. */
  deleteLabel?: string;
  onDelete?: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-2 @md:justify-between @md:border-t @md:border-[rgba(26,26,26,0.08)] @md:pt-3">
      <span className="hidden text-[12.5px] text-ink-3 @md:inline">{note}</span>
      <div className="flex gap-2">
        {onDelete === undefined ? null : (
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            aria-label={deleteLabel}
            title="Delete plan"
            className={cn(
              HIT,
              'inline-flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg text-ink-3 transition-colors hover:bg-danger-bg hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-60 @md:h-9 @md:w-9',
            )}
          >
            <IconTrash size={17} />
          </button>
        )}
        {canUse ? (
          <PlainButton
            tone="ghost"
            className={cn(HIT, 'h-10 @md:h-9')}
            disabled={busy}
            onClick={onUse}
          >
            Use this plan
          </PlainButton>
        ) : null}
        <Link
          href={openHref}
          className={cn(
            HIT,
            'inline-flex h-10 items-center rounded-lg bg-night px-[18px] text-[13.5px] font-semibold text-gold-lit no-underline hover:bg-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold @md:h-9 @md:px-4 @md:text-[13px]',
          )}
        >
          Open
        </Link>
      </div>
    </div>
  );
}

/** One saved AI plan in "My workout plans". */
export function PlanCard({
  plan,
  busy,
  onSetActive,
  onDelete,
}: {
  plan: MemberWorkoutPlanView;
  busy: boolean;
  onSetActive: (plan: MemberWorkoutPlanView) => void;
  /** Opens the "Delete this plan?" confirmation. */
  onDelete: (plan: MemberWorkoutPlanView) => void;
}) {
  return (
    <article
      className={cn(CARD, plan.isActive ? 'border-2 border-gold' : 'border border-border')}
      aria-label={`${plan.name}, made with AI${plan.isActive ? ', active plan' : ''}`}
    >
      <div className="flex flex-wrap gap-1.5">
        <Tag tone="warn" className={cn(BADGE, 'tracking-[0.08em] text-[#6e4c0e]')}>
          <IconSparkles size={12} strokeWidth={2} />
          Made with AI
        </Tag>
        {plan.isActive ? (
          <Tag tone="ok" className={BADGE}>
            Active
          </Tag>
        ) : null}
      </div>
      <h3 className="m-0 font-display text-[18px] font-bold">{plan.name}</h3>
      <p className="m-0 text-[13px] text-ink-2 @md:text-[13.5px]">{planMeta(plan)}</p>
      <Dots weekdays={plan.intake.weekdays} />
      <Footer
        note={savedLabel(plan)}
        canUse={!plan.isActive}
        busy={busy}
        openHref={`/portal/workouts/${encodeURIComponent(plan.id)}`}
        onUse={() => onSetActive(plan)}
        deleteLabel={`Delete ${plan.name}`}
        onDelete={() => onDelete(plan)}
      />
    </article>
  );
}

/**
 * The coach's plan, first in "My workout plans" (PhoneHubCoach.dc.html):
 * FROM COACH ANA, ACTIVE while no AI plan is, read-only behind Open.
 */
export function CoachPlanCard({
  plan,
  busy,
  onUse,
}: {
  plan: CoachPlanInWorkouts;
  busy: boolean;
  onUse: () => void;
}) {
  const title = coachPlanTitle(plan);
  return (
    <article
      className={cn(CARD, plan.isActive ? 'border-2 border-gold' : 'border border-border')}
      aria-label={`${title}${plan.isActive ? ', active plan' : ''}`}
    >
      <div className="flex flex-wrap gap-1.5">
        <Tag tone="info" className={cn(BADGE, 'tracking-[0.08em]')}>
          <IconPerson />
          {coachBadge(plan)}
        </Tag>
        {plan.isActive ? (
          <Tag tone="ok" className={BADGE}>
            Active
          </Tag>
        ) : null}
      </div>
      <h3 className="m-0 font-display text-[18px] font-bold">{title}</h3>
      <p className="m-0 text-[13px] text-ink-2 @md:text-[13.5px]">{coachPlanMeta(plan)}</p>
      <Dots weekdays={plan.weekdays.filter((w): w is number => w !== null)} />
      <Footer
        note={`Updated ${shortDate(plan.updatedAt)}`}
        canUse={!plan.isActive}
        busy={busy}
        openHref={COACH_PLAN_HREF}
        onUse={onUse}
      />
    </article>
  );
}

/** The dashed "Create a plan with AI" card. */
export function CreatePlanCard({ full }: { full: boolean }) {
  return (
    <Link
      href="/portal/workouts/new"
      aria-disabled={full || undefined}
      className={cn(
        'flex min-h-[196px] flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed border-[rgba(125,86,21,0.35)] bg-[#fffaf0] p-5 text-center text-foreground no-underline transition-colors hover:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
        full && 'pointer-events-none opacity-60',
      )}
    >
      <span
        className="flex h-11 w-11 items-center justify-center rounded-full bg-gold text-night"
        aria-hidden
      >
        <IconSparkles size={22} />
      </span>
      <span className="font-display text-[17px] font-bold">Create a plan with AI</span>
      <span className="max-w-[250px] text-[13px] leading-[1.45] text-ink-2">
        {full
          ? 'You keep 5 plans already — delete one to make room.'
          : "Tell it your goal and your week. It also reads your coach's measurements, your attendance and your bookings."}
      </span>
    </Link>
  );
}
