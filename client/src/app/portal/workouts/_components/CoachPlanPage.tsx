'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { CoachPlanInWorkouts } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';
import { CoachDayCard } from '@/components/workouts/coach/CoachDayCard';
import { IconArrowLeft, IconPerson, IconWarning } from '@/components/workouts/icons';
import type { GuideState } from '@/components/workouts/plan/HowToPanel';
import { SafetyLine } from '@/components/workouts/SafetyLine';
import { useSessionStarter } from '@/components/workouts/session/useSessionStarter';
import { Notice, Panel, PlainButton, Tag } from '@/components/workouts/ui';
import { workoutsApi } from '@/lib/workouts/api';
import { coachBadge, coachDays, coachPlanMeta, coachPlanTitle } from '@/lib/workouts/coachPlan';
import { workoutErrorMessage } from '@/lib/workouts/errors';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ok'; plan: CoachPlanInWorkouts | null };

const HUB = '/portal/workouts';

/**
 * `/portal/workouts/coach` — the plan the member's coach saved, read-only, in
 * the planner's day-card style: How to on every exercise, "Start this day" on
 * every day, and "Use this plan" to let it drive Today (spec §5).
 * `#coach-day-<n>` scrolls to and briefly rings that day, like a plan page.
 */
export function CoachPlanPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<{ day: number; index: number } | null>(null);
  const [guides, setGuides] = useState<Record<string, GuideState>>({});
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const starter = useSessionStarter();
  // A lapsed member reads the coach's plan; "Use this plan" is a write.
  const canWrite = useMemberCanWrite();

  const read = useCallback((): void => {
    workoutsApi
      .home()
      .then((home) => {
        setLoad({ kind: 'ok', plan: home.coachPlan });
        const hash = /^#coach-day-(\d{1,2})$/.exec(window.location.hash);
        setHighlighted(hash === null ? null : Number(hash[1]));
      })
      .catch((caught: unknown) =>
        setLoad({ kind: 'failed', message: workoutErrorMessage(caught) }),
      );
  }, []);

  useEffect(() => {
    read();
  }, [read]);

  // `#coach-day-<n>`: scroll there once, and let the gold ring fade.
  useEffect(() => {
    if (highlighted === null) return;
    const el = document.getElementById(`coach-day-${highlighted}`);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setHighlighted(null), 1600);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  const loadGuide = useCallback((name: string): void => {
    setGuides((prev) => ({ ...prev, [name]: { kind: 'loading' } }));
    workoutsApi
      .guide(name)
      .then((guide) => setGuides((prev) => ({ ...prev, [name]: { kind: 'ready', guide } })))
      .catch((caught: unknown) =>
        setGuides((prev) => ({
          ...prev,
          [name]: { kind: 'error', message: workoutErrorMessage(caught) },
        })),
      );
  }, []);

  const adopt = (): void => {
    setBusy(true);
    setNotice(null);
    workoutsApi
      .adoptCoachPlan()
      .then((plan) => setLoad({ kind: 'ok', plan: { ...plan, isActive: true } }))
      .catch((caught: unknown) => setNotice(workoutErrorMessage(caught)))
      .finally(() => setBusy(false));
  };

  if (load.kind === 'loading') {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your coach's plan">
        <Skeleton height={60} />
        <Skeleton height={160} />
        <Skeleton height={420} />
      </div>
    );
  }

  if (load.kind === 'failed' || load.plan === null) {
    return (
      <Card>
        <EmptyState
          title={
            load.kind === 'failed'
              ? "We could not load your coach's plan"
              : 'Your coach has not written a plan for you yet'
          }
          hint={
            load.kind === 'failed'
              ? load.message
              : 'When they do, it shows up here and first in My workout plans.'
          }
          action={
            <div className="flex flex-wrap justify-center gap-2.5">
              {load.kind === 'failed' ? (
                <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={read}>
                  Try again
                </button>
              ) : null}
              <Link href={HUB} className="p-btn p-btn-gold p-btn-sm">
                Back to Workouts
              </Link>
            </div>
          }
        />
      </Card>
    );
  }

  const plan = load.plan;
  const title = coachPlanTitle(plan);
  const days = coachDays(plan);

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
        <div className="flex min-w-0 items-center gap-2 @2xl:gap-3.5">
          <Link
            href={HUB}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-2 no-underline hover:bg-paper-3 @2xl:h-9 @2xl:w-auto @2xl:gap-1.5 @2xl:pr-2.5 @2xl:pl-1.5"
            aria-label="Back to Workouts"
          >
            <IconArrowLeft />
            <span className="hidden text-[14px] font-medium @2xl:inline">Workouts</span>
          </Link>
          <span aria-hidden className="hidden text-[#c7c3bc] @2xl:inline">
            /
          </span>
          <h1 className="m-0 truncate font-display text-[17px] font-bold @2xl:text-[20px]">
            {title}
          </h1>
        </div>

        <Panel
          aria-labelledby="wk-coach-h"
          className="flex flex-col gap-3 px-4 py-4 @3xl:px-7 @3xl:py-6"
        >
          <div className="flex flex-wrap gap-1.5">
            <Tag
              tone="info"
              className="gap-[5px] px-[9px] py-[3px] text-[10.5px] tracking-[0.08em]"
            >
              <IconPerson />
              {coachBadge(plan)}
            </Tag>
            {plan.isActive ? (
              <Tag tone="ok" className="px-[9px] py-[3px] text-[10.5px]">
                Active
              </Tag>
            ) : null}
          </div>
          <h2
            id="wk-coach-h"
            className="m-0 font-display text-[26px] leading-[1.1] font-extrabold tracking-[-0.01em] @3xl:text-[32px]"
          >
            {title}
          </h2>
          <p className="m-0 text-[13.5px] text-ink-2">{coachPlanMeta(plan)}</p>
          <div className="flex flex-col gap-1.5 border-t border-[rgba(26,26,26,0.08)] pt-3">
            <h3 className="m-0 text-[11.5px] font-bold tracking-[0.14em] text-ink-3 uppercase">
              Why this plan
            </h3>
            <p className="m-0 text-[14px] leading-[1.6] whitespace-pre-wrap text-[color:var(--p-ink)]">
              {plan.plan.summary}
            </p>
          </div>
          <div className="flex flex-col gap-2.5 @md:flex-row @md:items-center @md:justify-between">
            <p className="m-0 text-[13px] text-ink-3">
              {plan.isActive
                ? 'Today follows this plan. Your coach keeps it up to date.'
                : 'Written by your coach — ask them to change it. Use it and Today follows it.'}
            </p>
            {plan.isActive || !canWrite ? null : (
              <PlainButton tone="dark" className="h-11 @md:h-10" disabled={busy} onClick={adopt}>
                Use this plan
              </PlainButton>
            )}
          </div>
        </Panel>

        {notice === null ? null : (
          <Notice tone="warn" role="alert" icon={<IconWarning />}>
            {notice}
          </Notice>
        )}

        <div className="flex flex-col gap-4 @3xl:gap-[22px]">
          {days.map((day) => (
            <CoachDayCard
              key={day.anchor}
              day={day}
              highlighted={highlighted === day.index}
              openIndex={open !== null && open.day === day.index ? open.index : null}
              guideFor={(name) => guides[name] ?? null}
              starter={starter}
              onHow={(index) => {
                const name = day.exercises[index]?.name;
                if (name === undefined) return;
                const same = open !== null && open.day === day.index && open.index === index;
                setOpen(same ? null : { day: day.index, index });
                if (!same && guides[name] === undefined) loadGuide(name);
              }}
              onRetryGuide={loadGuide}
            />
          ))}
        </div>

        <SafetyLine />
      </div>
    </div>
  );
}
