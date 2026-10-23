'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import type { MemberWorkoutPlanView, WorkoutAiQuotaView } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';
import { PlanScreen } from '@/components/workouts/plan/PlanScreen';
import { QuotaPill } from '@/components/workouts/QuotaPill';
import { DeletePlanDialog } from '@/components/workouts/DeletePlanDialog';
import { IconArrowLeft, IconTrash } from '@/components/workouts/icons';
import { StartDayButton } from '@/components/workouts/session/StartDayButton';
import { useSessionStarter } from '@/components/workouts/session/useSessionStarter';
import { buttonClass } from '@/components/workouts/ui';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { workoutsApi } from '@/lib/workouts/api';
import { isDraftMissing, workoutErrorMessage } from '@/lib/workouts/errors';
import { loadWeekBookings } from '@/lib/workouts/loadHub';
import { bookedClassesByWeekday } from '@/lib/workouts/today';

/**
 * `/portal/workouts/[planId]` — a saved plan (Plan.dc.html in saved mode).
 *
 * The id comes from `useParams()` and is untrusted: the server scopes every
 * read to the caller and answers any other id with one 404, which this page
 * renders as "not one of your plans". `#day-<weekday>` is read once from the
 * location; `?adjust=<weekday>` through `useSearchParams` under Suspense.
 */

function weekdayParam(value: string | null): number | null {
  if (value === null || !/^[0-6]$/.test(value)) return null;
  return Number(value);
}

export function PlanPage() {
  const params = useParams<{ planId: string }>();
  const planId = params.planId;
  const adjustWeekday = weekdayParam(useSearchParams().get('adjust'));

  const [plan, setPlan] = useState<MemberWorkoutPlanView | null>(null);
  const [failed, setFailed] = useState<{ notFound: boolean; message: string } | null>(null);
  const [quota, setQuota] = useState<WorkoutAiQuotaView | null>(null);
  const [classes, setClasses] = useState<Record<number, string>>({});
  const [focusWeekday, setFocusWeekday] = useState<number | null>(null);
  const [hasCoachPlan, setHasCoachPlan] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const router = useRouter();
  const starter = useSessionStarter();
  // A lapsed member reads the plan; deleting or activating it is a write.
  const canWrite = useMemberCanWrite();

  const load = useCallback((): void => {
    workoutsApi
      .plan(planId)
      .then((view) => {
        setFailed(null);
        setPlan(view);
        // The hash is client-only; read it once the plan is on its way.
        const hash = /^#day-([0-6])$/.exec(window.location.hash);
        setFocusWeekday(hash === null ? null : Number(hash[1]));
      })
      .catch((caught: unknown) =>
        setFailed({ notFound: isDraftMissing(caught), message: workoutErrorMessage(caught) }),
      );
  }, [planId]);

  useEffect(() => {
    load();
    const today = gymToday(new Date(), GYM_TIMEZONE);
    let cancelled = false;
    void workoutsApi
      .home()
      .then((home) => {
        if (cancelled) return;
        setQuota(home.quota);
        setHasCoachPlan(home.coachPlan !== null);
      })
      .catch(() => undefined);
    void loadWeekBookings(today)
      .then((bookings) => {
        if (!cancelled) setClasses(bookedClassesByWeekday(bookings, today, 'long'));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [load]);

  const onBodySaved = useCallback((view: MemberWorkoutPlanView): void => {
    setPlan((prev) => (prev === null ? view : { ...prev, ...view, plan: prev.plan }));
  }, []);

  if (failed !== null) {
    return (
      <Card>
        <EmptyState
          title={failed.notFound ? 'That is not one of your plans' : 'We could not load this plan'}
          hint={
            failed.notFound ? 'It may have been deleted, or the link is wrong.' : failed.message
          }
          action={
            <div className="flex flex-wrap justify-center gap-2.5">
              {failed.notFound ? null : (
                <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={load}>
                  Try again
                </button>
              )}
              <Link href="/portal/workouts" className="p-btn p-btn-gold p-btn-sm">
                Back to Workouts
              </Link>
            </div>
          }
        />
      </Card>
    );
  }

  if (plan === null) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your plan">
        <Skeleton height={60} />
        <Skeleton height={160} />
        <Skeleton height={420} />
      </div>
    );
  }

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 @2xl:gap-3.5">
            <Link
              href="/portal/workouts"
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
              {plan.name}
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <QuotaPill quota={quota} />
            {plan.isActive || !canWrite ? null : (
              <Link
                href="/portal/workouts"
                className={buttonClass('ghost', 'xs', 'hidden @2xl:inline-flex')}
              >
                Set active on the hub
              </Link>
            )}
            <button
              type="button"
              hidden={!canWrite}
              onClick={() => setConfirmDelete(true)}
              aria-label={`Delete ${plan.name}`}
              className={buttonClass(
                'ghost',
                'xs',
                'h-11 w-11 px-0 text-ink-2 hover:border-danger hover:text-danger @2xl:h-9 @2xl:w-auto @2xl:px-3',
              )}
            >
              <IconTrash size={16} />
              <span className="hidden @2xl:inline">Delete</span>
            </button>
          </div>
        </div>
        <PlanScreen
          key={plan.id}
          mode="saved"
          planId={plan.id}
          name={plan.name}
          intake={plan.intake}
          body={plan.plan}
          meta={{ source: plan.source, createdAt: plan.createdAt, updatedAt: plan.updatedAt }}
          isActive={plan.isActive}
          quota={quota}
          onQuota={setQuota}
          classes={classes}
          focusWeekday={focusWeekday}
          adjustWeekday={adjustWeekday}
          regenerateHref={`/portal/workouts/new?from=${encodeURIComponent(plan.id)}`}
          onBodySaved={onBodySaved}
          renderStart={(day) => (
            <StartDayButton
              starter={starter}
              dayName={day.title}
              body={{ source: 'MEMBER_PLAN', planId: plan.id, weekday: day.weekday }}
            />
          )}
        />
      </div>

      <DeletePlanDialog
        plan={confirmDelete ? plan : null}
        hasCoachPlan={hasCoachPlan}
        onClose={() => setConfirmDelete(false)}
        onDeleted={() => {
          toast.success(`${plan.name} deleted`);
          router.replace('/portal/workouts');
        }}
      />
    </div>
  );
}
