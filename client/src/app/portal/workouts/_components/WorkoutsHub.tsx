'use client';

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { WORKOUT_LIBRARY_LIMIT, type MemberWorkoutPlanView } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';
import { DeletePlanDialog } from '@/components/workouts/DeletePlanDialog';
import { DraftBanner } from '@/components/workouts/DraftBanner';
import { HubToday, PhoneWeekCard } from '@/components/workouts/HubToday';
import { CoachPlanCard, CreatePlanCard, PlanCard } from '@/components/workouts/PlanCard';
import { QuotaMeter } from '@/components/workouts/QuotaMeter';
import { QuotaPill } from '@/components/workouts/QuotaPill';
import { RecentWorkouts } from '@/components/workouts/RecentWorkouts';
import { SafetyLine } from '@/components/workouts/SafetyLine';
import { TipCard } from '@/components/workouts/TipCard';
import { TodayExercises } from '@/components/workouts/TodayExercises';
import { IconSparkles } from '@/components/workouts/icons';
import { useSessionStarter } from '@/components/workouts/session/useSessionStarter';
import { Notice, buttonClass } from '@/components/workouts/ui';
import { workoutsApi } from '@/lib/workouts/api';
import { workoutErrorMessage } from '@/lib/workouts/errors';
import { tipOfTheDay } from '@/lib/workouts/guidance';
import { loadHub, type HubData } from '@/lib/workouts/loadHub';
import { todayModel, trainingProgress, weekStrip } from '@/lib/workouts/today';
import { plannedWeek, todaySource, workoutDays } from '@/lib/workouts/todaySource';

/**
 * `/portal/workouts` — the hub (Main.dc.html; PhoneToday.dc.html and
 * PhoneHubCoach.dc.html at 390).
 *
 * Everything on it is sourced: the open workout or today's plan decides
 * Today, the check-in summary and finished workouts tick the strip, this
 * week's bookings colour it, the quota is the server's. When a section could
 * not be read it is absent, never invented.
 */
export function WorkoutsHub() {
  const [data, setData] = useState<HubData | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<MemberWorkoutPlanView | null>(null);
  const starter = useSessionStarter();
  // A lapsed member keeps their library on screen; every change to it is a write.
  const canWrite = useMemberCanWrite();

  const load = useCallback((): void => {
    loadHub(new Date())
      .then((next) => {
        setFailed(null);
        setData(next);
      })
      .catch((caught: unknown) => setFailed(workoutErrorMessage(caught)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const setActive = useCallback((plan: MemberWorkoutPlanView): void => {
    setBusyPlan(plan.id);
    setNotice(null);
    workoutsApi
      .patchPlan(plan.id, { isActive: true })
      .then((saved) => {
        setData((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                home: {
                  ...prev.home,
                  plans: prev.home.plans.map((p) =>
                    p.id === saved.id ? { ...saved, isActive: true } : { ...p, isActive: false },
                  ),
                  // An active AI plan takes Today from the coach's plan.
                  coachPlan:
                    prev.home.coachPlan === null
                      ? null
                      : { ...prev.home.coachPlan, isActive: false },
                },
              },
        );
      })
      .catch((caught: unknown) => setNotice(workoutErrorMessage(caught)))
      .finally(() => setBusyPlan(null));
  }, []);

  const adoptCoach = useCallback((): void => {
    setBusyPlan('coach');
    setNotice(null);
    workoutsApi
      .adoptCoachPlan()
      .then((coachPlan) => {
        setData((prev) =>
          prev === null
            ? prev
            : {
                ...prev,
                home: {
                  ...prev.home,
                  plans: prev.home.plans.map((p) => ({ ...p, isActive: false })),
                  coachPlan: { ...coachPlan, isActive: true },
                },
              },
        );
      })
      .catch((caught: unknown) => setNotice(workoutErrorMessage(caught)))
      .finally(() => setBusyPlan(null));
  }, []);

  // The hub reloads after a delete rather than patching locally: removing the
  // active plan hands Today to the coach's plan (or to nothing), and the
  // server decides which.
  const onDeleted = useCallback(
    (planId: string): void => {
      const name = data?.home.plans.find((p) => p.id === planId)?.name ?? 'Plan';
      toast.success(`${name} deleted`);
      load();
    },
    [data, load],
  );

  if (failed !== null) {
    return (
      <Card>
        <EmptyState
          title="We could not load your workouts"
          hint={failed}
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={load}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  if (data === null) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your workouts">
        <Skeleton height={260} />
        <Skeleton height={220} />
      </div>
    );
  }

  const { home, today } = data;
  const source = todaySource(home);
  const model = todayModel(home, today);
  const planned = { days: plannedWeek(source) };
  const cells = weekStrip(planned, data.checkIns, data.bookings, today, workoutDays(home.recent));
  const progress = planned.days.length > 0 ? trainingProgress(cells, planned) : null;
  const tip = source.kind === 'member' ? tipOfTheDay(source.plan.plan.guidance, today) : null;
  const noPlans = home.plans.length === 0 && home.coachPlan === null;
  const full = home.plans.length >= WORKOUT_LIBRARY_LIMIT;
  const busy = busyPlan !== null || !canWrite;

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @3xl:gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="m-0 font-display text-[20px] font-bold @3xl:sr-only">Workouts</h1>
          <QuotaPill quota={home.quota} />
        </div>

        {home.draft === null ? null : <DraftBanner draft={home.draft} />}
        {notice === null ? null : (
          <Notice tone="warn" role="alert">
            {notice}
          </Notice>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] gap-3.5 @3xl:gap-6">
          <HubToday
            model={model}
            cells={cells}
            today={today}
            progress={progress}
            draftRunning={home.draft?.status === 'RUNNING'}
            starter={starter}
          />
          <PhoneWeekCard cells={cells} progress={progress} />
        </div>

        {noPlans && home.recent.length === 0 ? null : model.kind === 'train' ? (
          // A training day: today's exercises lead, the side cards stack beside them.
          <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 @3xl:grid-cols-[minmax(0,1fr)_360px] @3xl:gap-6">
            <TodayExercises exercises={model.exercises} planHref={model.planHref} />
            <div className="flex flex-col gap-5 @3xl:gap-6">
              {home.recent.length === 0 ? null : <RecentWorkouts recent={home.recent} />}
              <QuotaMeter quota={home.quota} />
              {tip === null ? null : <TipCard tip={tip} />}
            </div>
          </div>
        ) : (
          // Rest day or done for today: no exercise list to sit beside, so the
          // side cards share the row instead of hugging the right edge of an
          // empty column (owner, 2026-10-06). Equal heights, one row on wide
          // screens, two then one as the column narrows.
          <div className="grid grid-cols-[minmax(0,1fr)] items-stretch gap-5 @2xl:grid-cols-2 @5xl:grid-cols-3 @3xl:gap-6">
            {home.recent.length === 0 ? null : <RecentWorkouts recent={home.recent} />}
            <QuotaMeter quota={home.quota} />
            {tip === null ? null : <TipCard tip={tip} />}
          </div>
        )}

        <section aria-labelledby="wk-plans-h" className="flex flex-col gap-3.5">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2
                id="wk-plans-h"
                className="m-0 font-display text-[19px] font-bold @md:text-[22px]"
              >
                My workout plans
              </h2>
              <span className="text-[12.5px] text-ink-3 @md:text-[13px]">
                {home.coachPlan === null ? '' : '1 from your coach · '}
                {home.plans.length} of {WORKOUT_LIBRARY_LIMIT} saved
              </span>
            </div>
            {home.plans.length === 0 || full || !canWrite ? null : (
              <Link
                href="/portal/workouts/new"
                className={buttonClass('gold', 'sm', 'hidden @md:inline-flex')}
              >
                <IconSparkles />
                New plan with AI
              </Link>
            )}
          </div>
          <div className="grid grid-cols-[minmax(0,1fr)] gap-2.5 @md:gap-4 @xl:grid-cols-2 @3xl:grid-cols-3 @3xl:gap-5 @7xl:grid-cols-4">
            {home.coachPlan === null ? null : (
              <CoachPlanCard plan={home.coachPlan} busy={busy} onUse={adoptCoach} />
            )}
            {home.plans.map((plan) => (
              <PlanCard
                key={plan.id}
                plan={plan}
                busy={busy}
                onSetActive={setActive}
                onDelete={setDeleting}
              />
            ))}
            {canWrite ? <CreatePlanCard full={full} /> : null}
          </div>
        </section>

        <SafetyLine />
      </div>

      <DeletePlanDialog
        plan={deleting}
        hasCoachPlan={home.coachPlan !== null}
        onClose={() => setDeleting(null)}
        onDeleted={onDeleted}
      />
    </div>
  );
}
