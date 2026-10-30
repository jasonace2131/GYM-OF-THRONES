'use client';

import Link from 'next/link';
import { IconDumbbell } from '@/components/portal/icons';
import type { CivilDate } from '@/lib/gymTime';
import { startKey } from '@/lib/workouts/todaySource';
import { todayKicker, weekExplanation, type TodayModel, type WeekCell } from '@/lib/workouts/today';
import { cn } from '@/lib/utils';
import { Chip, Kicker, KickerHeading, Panel, buttonClass } from './ui';
import { IconCheck, IconClock, IconPlay, IconSliders, IconSparkles, IconSpinner } from './icons';
import { SegmentBar } from './session/SegmentBar';
import { StartFeedback } from './session/StartFeedback';
import type { SessionStarter } from './session/useSessionStarter';
import { WeekStrip } from './WeekStrip';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

type Progress = { done: number; total: number } | null;

const TITLE =
  'm-0 font-display text-[30px] leading-[1.05] font-extrabold tracking-[-0.01em] @3xl:text-[40px]';

/** IN PROGRESS / NOT FINISHED / DONE beside the kicker (PhoneHubCoach.dc.html). */
function StateBadge({ kind, leftOpen = false }: { kind: 'open' | 'done'; leftOpen?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full px-[9px] py-[3px] text-[11px] font-bold tracking-[0.1em] uppercase',
        kind === 'open' ? 'bg-warn-bg text-[#6e4c0e]' : 'bg-ok-bg text-ok',
      )}
    >
      {kind === 'open' ? (
        <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-gold" />
      ) : (
        <IconCheck size={12} strokeWidth={2.8} />
      )}
      {kind === 'open' ? (leftOpen ? 'Not finished' : 'In progress') : 'Done'}
    </span>
  );
}

/**
 * The hub's Today band: the workout in progress, the one done today, today's
 * day to Start (from the active AI plan or the coach's), a rest day, "Which
 * day are you doing?", or the empty state — with THIS WEEK beside it on a
 * desktop. On a phone THIS WEEK is its own card below (`PhoneWeekCard`).
 */
export function HubToday({
  model,
  cells,
  today,
  progress,
  draftRunning,
  starter,
}: {
  model: TodayModel;
  cells: WeekCell[];
  today: CivilDate;
  progress: Progress;
  draftRunning: boolean;
  starter: SessionStarter;
}) {
  // A lapsed member sees Today but may not start, adjust or create (writes).
  const canWrite = useMemberCanWrite();
  const starting = (key: string): boolean =>
    starter.state.kind === 'starting' && starter.state.key === key;

  return (
    <Panel
      aria-labelledby="wk-today-h"
      className={cn(
        'grid grid-cols-[minmax(0,1fr)] gap-5 p-[18px] @3xl:grid-cols-[minmax(0,1fr)_480px] @3xl:gap-8 @3xl:px-[30px] @3xl:py-7',
        model.kind === 'open' && 'border-2 border-gold',
      )}
    >
      <div className="flex flex-col justify-center gap-3 @3xl:gap-4">
        <div className="flex items-center justify-between gap-2">
          <Kicker>
            <span className="@md:hidden">{todayKicker(today, 'short')}</span>
            <span className="hidden @md:inline">{todayKicker(today, 'long')}</span>
          </Kicker>
          {model.kind === 'open' ? (
            <StateBadge kind="open" leftOpen={model.leftOpen} />
          ) : model.kind === 'done' ? (
            <StateBadge kind="done" />
          ) : null}
        </div>

        {model.kind === 'none' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 id="wk-today-h" className={TITLE}>
                No plan yet
              </h2>
              <p className="m-0 text-[15px] leading-[1.5] text-ink-2">
                Build one with AI in about a minute. Tell it your goal and your week; it also reads
                your coach&apos;s measurements, your attendance and your bookings.
              </p>
            </div>
            <div className={canWrite ? 'mt-1 flex flex-wrap gap-2.5' : 'hidden'}>
              <Link
                href={draftRunning ? '/portal/workouts/draft' : '/portal/workouts/new'}
                className={buttonClass('gold', 'md', 'w-full @md:w-auto')}
              >
                <IconSparkles />
                {draftRunning ? 'Continue your draft' : 'Create a plan with AI'}
              </Link>
            </div>
          </>
        ) : model.kind === 'open' ? (
          <>
            <div className="flex flex-col gap-1">
              <h2 id="wk-today-h" className={TITLE}>
                {model.title}
              </h2>
              <p className="m-0 text-[13.5px] text-ink-2 @md:text-[15px]">{model.line}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex justify-between gap-3 text-[12.5px] text-[color:var(--p-ink)]">
                <span>
                  <strong className="font-bold">
                    {model.progress.complete} of {model.progress.total}
                  </strong>{' '}
                  exercises done
                </span>
                <span>{model.startedLabel}</span>
              </div>
              <SegmentBar segments={model.progress.segments} size="card" />
            </div>
            {model.leftOpen ? (
              <p className="m-0 text-[13.5px] leading-[1.5] text-ink-2">
                This workout was never finished. Open it to finish or discard it, then you can start
                today&apos;s.
              </p>
            ) : null}
            <Link
              href={model.href}
              className={buttonClass('gold', 'md', 'h-[50px] text-[14.5px] @md:w-fit')}
            >
              <IconPlay />
              {model.leftOpen ? 'Finish or discard' : 'Continue workout'}
            </Link>
          </>
        ) : model.kind === 'done' ? (
          <>
            <div className="flex flex-col gap-1">
              <h2 id="wk-today-h" className={TITLE}>
                {model.title}
              </h2>
              <p className="m-0 text-[13.5px] text-ink-2 @md:text-[15px]">
                {model.summary.planName}
              </p>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-ok-bg px-4 py-3 text-[#1a4d2e]">
              <span
                aria-hidden
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ok text-white"
              >
                <IconCheck size={18} strokeWidth={2.8} />
              </span>
              <span className="flex min-w-0 flex-col gap-px">
                <strong className="text-[14.5px] font-semibold">Done today — nice work.</strong>
                <span className="text-[13px]">{model.line}</span>
              </span>
            </div>
            <Link href={model.href} className={buttonClass('dark', 'md', 'h-12 @md:w-fit')}>
              View summary
            </Link>
          </>
        ) : model.kind === 'pick' ? (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 id="wk-today-h" className={TITLE}>
                Which day are you doing?
              </h2>
              <p className="m-0 text-[14px] leading-[1.5] text-ink-2 @md:text-[15px]">
                {model.lead}
              </p>
            </div>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {model.days.map((day) => (
                <li key={day.key} className="flex flex-col gap-2">
                  <button
                    type="button"
                    disabled={!canWrite || starter.state.kind === 'starting'}
                    onClick={() => void starter.start(day.start)}
                    className="grid min-h-[60px] w-full cursor-pointer grid-cols-[minmax(0,1fr)_auto_36px] items-center gap-3 rounded-xl border-[1.5px] border-[color:var(--p-border-2)] bg-card px-4 py-2.5 text-left transition-colors hover:border-gold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-wait disabled:opacity-70 motion-reduce:transition-none"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-[11px] font-bold tracking-[0.12em] text-ink-3 uppercase">
                        {day.label}
                      </span>
                      <span className="truncate text-[15px] font-semibold">{day.title}</span>
                    </span>
                    <span className="text-[12.5px] text-ink-3">{day.count}</span>
                    <span
                      aria-hidden
                      className="flex h-9 w-9 items-center justify-center rounded-full bg-primary text-primary-foreground"
                    >
                      {starting(day.key) ? (
                        <IconSpinner size={16} className="motion-safe:animate-spin" />
                      ) : (
                        <IconPlay size={16} />
                      )}
                    </span>
                  </button>
                  <StartFeedback starter={starter} startKey={day.key} />
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <h2 id="wk-today-h" className={TITLE}>
                {model.title}
              </h2>
              <p className="m-0 text-[15px] leading-[1.5] text-ink-2">
                {model.lead}{' '}
                <strong className="font-semibold text-foreground">{model.planName}</strong>.
              </p>
            </div>

            {model.kind === 'train' ? (
              <div className="flex flex-wrap gap-2">
                <Chip>
                  <IconDumbbell size={14} />
                  {model.chips[0]}
                </Chip>
                {model.chips[1] === undefined ? null : (
                  <Chip>
                    <IconClock />
                    {model.chips[1]}
                  </Chip>
                )}
                {model.chips[2] === undefined ? null : <Chip>{model.chips[2]}</Chip>}
              </div>
            ) : null}

            {model.kind === 'train' ? (
              <>
                <div
                  className={cn(
                    'mt-1 grid gap-2 @md:flex @md:flex-wrap @md:gap-2.5',
                    model.adjustHref === null || !canWrite
                      ? 'grid-cols-[minmax(0,1fr)]'
                      : 'grid-cols-[minmax(0,1fr)_auto]',
                  )}
                >
                  <button
                    type="button"
                    disabled={!canWrite || starter.state.kind === 'starting'}
                    onClick={() => void starter.start(model.start)}
                    className={buttonClass('gold', 'md', 'h-12 cursor-pointer @md:h-[46px]')}
                  >
                    <IconDumbbell size={18} />
                    {starting(startKey(model.start)) ? (
                      'Starting…'
                    ) : (
                      <>
                        <span className="@md:hidden">Start workout</span>
                        <span className="hidden @md:inline">Start today&apos;s workout</span>
                      </>
                    )}
                  </button>
                  {model.adjustHref === null || !canWrite ? null : (
                    <Link
                      href={model.adjustHref}
                      className={buttonClass('ghost', 'md', 'h-12 px-3.5 @md:h-[46px] @md:px-5')}
                    >
                      <IconSliders size={16} />
                      <span className="@md:hidden">Adjust</span>
                      <span className="hidden @md:inline">Adjust today</span>
                    </Link>
                  )}
                </div>
                <StartFeedback starter={starter} startKey={startKey(model.start)} />
              </>
            ) : model.nextHref === null ? null : (
              <div className="mt-1 flex flex-wrap gap-2.5">
                <Link
                  href={model.nextHref}
                  className={buttonClass('dark', 'md', 'h-12 @md:h-[46px]')}
                >
                  Open next session
                </Link>
              </div>
            )}
          </>
        )}
      </div>

      <div className="hidden flex-col gap-4 rounded-xl border border-[rgba(26,26,26,0.07)] bg-[#f7f6f3] p-4 @3xl:flex @md:px-[22px] @md:py-5">
        <div className="flex items-baseline justify-between gap-3">
          <Kicker>This week</Kicker>
          {progress === null ? null : (
            <span className="text-[13px] text-ink-2">
              <strong className="font-semibold text-foreground">
                {progress.done} of {progress.total}
              </strong>{' '}
              training days done
            </span>
          )}
        </div>
        <WeekStrip cells={cells} />
        <p className="m-0 text-[12.5px] leading-[1.45] text-ink-2">{weekExplanation(cells)}</p>
      </div>
    </Panel>
  );
}

/** THIS WEEK as its own card below Today, on a phone (PhoneHubCoach.dc.html). */
export function PhoneWeekCard({ cells, progress }: { cells: WeekCell[]; progress: Progress }) {
  return (
    <section
      aria-labelledby="wk-week-phone-h"
      className="flex flex-col gap-2.5 rounded-[14px] border border-border bg-card px-4 py-3.5 @3xl:hidden"
    >
      <div className="flex items-baseline justify-between gap-3">
        <KickerHeading id="wk-week-phone-h">This week</KickerHeading>
        {progress === null ? null : (
          <span className="text-[12.5px] text-ink-2">
            <strong className="font-semibold text-foreground">
              {progress.done} of {progress.total}
            </strong>{' '}
            done
          </span>
        )}
      </div>
      <WeekStrip cells={cells} compact />
    </section>
  );
}
