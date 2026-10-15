import Link from 'next/link';
import { IconFlame, IconScan } from '@/components/portal/icons';
import { ProgressRing } from '@/components/portal/ui';
import { StatusBadge } from '@/components/schedule/StatusBadge';
import type { MembershipStatusView, StatusTone } from '@/lib/dashboard/membershipStatus';
import { cn } from '@/lib/utils';

/**
 * The status band — the one thing a member opens the app to learn: am I in,
 * and until when.
 *
 * It leads instead of a row of equal tiles, because "your plan ends Friday"
 * and "you did 23 check-ins" are not equally important — one decides whether
 * the door opens, the other is trivia. Everything it says comes from
 * `membershipStatusView()`, keyed on the server's verdict.
 */

const FRAME: Record<StatusTone, string> = {
  ok: 'bg-[linear-gradient(135deg,#fff_0%,#f7f6f3_100%)]',
  neutral: 'bg-[linear-gradient(135deg,#fff_0%,#f7f6f3_100%)]',
  warn: 'border-[rgba(201,146,42,0.32)] bg-[linear-gradient(135deg,#fff_0%,#fdf7ea_100%)]',
  danger: 'border-[rgba(140,26,20,0.28)] bg-[linear-gradient(135deg,#fff_0%,#fdf1f0_100%)]',
};

const BADGE_TONE: Record<StatusTone, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  ok: 'ok',
  warn: 'warn',
  danger: 'danger',
  neutral: 'neutral',
};

export function StatusBand({
  greeting,
  firstName,
  view,
  streak,
  nextUp,
}: {
  greeting: string;
  firstName: string;
  view: MembershipStatusView;
  streak: string | null;
  nextUp: { title: string; when: string; coach: string } | null;
}) {
  const { ring } = view;

  return (
    <section
      aria-labelledby="dash-greeting"
      className={cn('p-card p-rise overflow-hidden', FRAME[view.tone])}
    >
      <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-5 p-5 @xl:gap-x-8 @xl:p-7">
        <div className="min-w-0">
          <h1 id="dash-greeting" className="p-h1">
            <span className="mb-1 block font-sans text-[13px] font-normal tracking-normal text-muted-foreground">
              {greeting},
            </span>
            {firstName}
          </h1>

          <div className="mt-3.5 flex flex-wrap items-center gap-2">
            <StatusBadge tone={BADGE_TONE[view.tone]}>{view.badge}</StatusBadge>
            {streak !== null ? (
              <StatusBadge tone="neutral" className="gap-1.5">
                <IconFlame size={12} />
                {streak}
              </StatusBadge>
            ) : null}
          </div>
        </div>

        {ring !== null ? (
          <div className="row-span-2 flex flex-col items-center gap-2.5 self-start @xl:self-center">
            <div className="@xl:hidden">
              <ProgressRing
                remaining={ring.remaining}
                total={ring.total}
                tone={ring.tone}
                size={84}
              />
            </div>
            <div className="hidden @xl:block">
              <ProgressRing
                remaining={ring.remaining}
                total={ring.total}
                tone={ring.tone}
                size={108}
              />
            </div>
            {/* With a ring, the date is its caption — on wide layouts. */}
            {view.untilLabel !== null ? (
              <span className="hidden text-center text-[12px] text-muted-foreground @xl:block">
                {view.untilLabel}
              </span>
            ) : null}
          </div>
        ) : null}

        {/* Beside the ring when there is one; the full width when there is not. */}
        <div className={cn('col-span-2 min-w-0', ring !== null && '@xl:col-span-1')}>
          {view.line !== null ? (
            <p className="m-0 mt-3.5 max-w-[62ch] text-[14px] leading-relaxed text-ink-2">
              {view.line}
            </p>
          ) : null}

          {nextUp !== null ? (
            <p className="m-0 mt-3 text-[14px] leading-relaxed text-ink-2">
              Next up — <strong className="font-semibold text-foreground">{nextUp.title}</strong>{' '}
              {nextUp.when}, with {nextUp.coach}.
            </p>
          ) : null}

          {view.primaryCta !== null || view.untilLabel !== null ? (
            <div className="mt-5 flex flex-wrap items-center gap-x-2.5 gap-y-3">
              {view.primaryCta !== null ? (
                <Link
                  href={view.primaryCta.href}
                  className="p-btn p-btn-gold flex-1 text-primary-foreground hover:text-primary-foreground @md:flex-none"
                >
                  {view.primaryCta.href === '/portal/checkin' ? <IconScan size={15} /> : null}
                  {view.primaryCta.label}
                </Link>
              ) : null}
              {view.secondaryCta !== null ? (
                <Link
                  href={view.secondaryCta.href}
                  className="p-btn p-btn-ghost flex-1 text-foreground hover:text-gold-deep @md:flex-none"
                >
                  {view.secondaryCta.label}
                </Link>
              ) : null}
              {view.untilLabel !== null ? (
                <span
                  className={cn(
                    'w-full text-[12.5px] text-muted-foreground @md:ml-auto @md:w-auto',
                    ring !== null && '@xl:hidden',
                  )}
                >
                  {view.untilLabel}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
