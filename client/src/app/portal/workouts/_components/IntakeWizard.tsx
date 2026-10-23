'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import type { MyBookingWire, MyCheckInSummary, WorkoutAiQuotaView } from '@got/shared';
import { Skeleton } from '@/components/portal/ui';
import { AboutStep } from '@/components/workouts/intake/AboutStep';
import { GoalStep } from '@/components/workouts/intake/GoalStep';
import { HealthStep } from '@/components/workouts/intake/HealthStep';
import { IntakeFooter } from '@/components/workouts/intake/IntakeFooter';
import { IntakeRail } from '@/components/workouts/intake/IntakeRail';
import { IntakeSteps } from '@/components/workouts/intake/IntakeSteps';
import { WeekStep } from '@/components/workouts/intake/WeekStep';
import { QuotaPill } from '@/components/workouts/QuotaPill';
import { IconArrowLeft, IconWarning } from '@/components/workouts/icons';
import { Notice, Panel } from '@/components/workouts/ui';
import { apiFetch } from '@/lib/api';
import { classesApi } from '@/lib/classes';
import { GYM_TIMEZONE, addDays, gymToday } from '@/lib/gymTime';
import type { ProgressSummary } from '@/lib/progress/types';
import { getProfile } from '@/lib/account';
import { keepSuitableGoal, type AccountBody } from '@/lib/workouts/body';
import { workoutsApi } from '@/lib/workouts/api';
import { isQuotaExhausted, workoutErrorMessage } from '@/lib/workouts/errors';
import { bookingHint, gymFacts } from '@/lib/workouts/facts';
import {
  buildRequest,
  initialIntake,
  intakeReducer,
  prefillIntake,
  restoreIntake,
  serializeIntake,
  stepProblem,
  type IntakeState,
} from '@/lib/workouts/intake';
import { limitNotice } from '@/lib/workouts/quota';

/**
 * `/portal/workouts/new` — the four-step intake (Intake.dc.html;
 * PhoneHealth.dc.html at 390).
 *
 * `?from=<planId>` prefills from that plan's stored intake (Regenerate);
 * `?from=draft` restores THIS TAB's last answers after a failed generation;
 * otherwise `lastIntake` from the hub. The reducer owns every answer, and
 * only `buildRequest` ever turns them into a wire body — the seven health
 * answers become one boolean there and go nowhere else.
 */

/** sessionStorage key for "Try again". This tab only; cleared on save or cancel. */
export const INTAKE_SESSION_KEY = 'got.workouts.intake';

interface Context {
  quota: WorkoutAiQuotaView | null;
  progress: ProgressSummary | null;
  checkIns: MyCheckInSummary | null;
  bookings: MyBookingWire[];
  /** The account's height and weight; null when `/me/profile` could not be read. */
  body: AccountBody | null;
}

function readSession(): string | null {
  try {
    return window.sessionStorage.getItem(INTAKE_SESSION_KEY);
  } catch {
    return null;
  }
}

function writeSession(state: IntakeState): void {
  try {
    window.sessionStorage.setItem(INTAKE_SESSION_KEY, serializeIntake(state));
  } catch {
    // Private mode or a full store: "Try again" simply starts blank.
  }
}

export function IntakeWizard() {
  const router = useRouter();
  const from = useSearchParams().get('from');
  const [state, dispatch] = useReducer(intakeReducer, undefined, initialIntake);
  const [ready, setReady] = useState(false);
  const [context, setContext] = useState<Context>({
    quota: null,
    progress: null,
    checkIns: null,
    bookings: [],
    body: null,
  });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'danger'; text: React.ReactNode } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    const today = gymToday(new Date(), GYM_TIMEZONE);

    const prefill = async (): Promise<IntakeState | null> => {
      if (from === 'draft') {
        const restored = restoreIntake(readSession());
        if (restored !== null) return restored;
      }
      if (from !== null && from !== 'draft') {
        try {
          const plan = await workoutsApi.plan(from);
          return prefillIntake(plan.intake);
        } catch {
          // An unknown or foreign id: fall through to lastIntake.
        }
      }
      return null;
    };

    void Promise.allSettled([
      workoutsApi.home(),
      apiFetch<ProgressSummary>('/me/progress'),
      apiFetch<MyCheckInSummary>('/me/check-ins/summary'),
      classesApi.myBookings({ from: today, to: addDays(today, 14) }),
      prefill(),
      getProfile(),
    ]).then(([home, progress, checkIns, bookings, prefilled, profile]) => {
      if (cancelled) return;
      const homeValue = home.status === 'fulfilled' ? home.value : null;
      const body: AccountBody | null =
        profile.status === 'fulfilled'
          ? { heightCm: profile.value.heightCm, weightKg: profile.value.weightKg }
          : null;
      setContext({
        quota: homeValue?.quota ?? null,
        progress: progress.status === 'fulfilled' ? progress.value : null,
        checkIns: checkIns.status === 'fulfilled' ? checkIns.value : null,
        bookings: bookings.status === 'fulfilled' ? bookings.value : [],
        body,
      });
      const start =
        (prefilled.status === 'fulfilled' ? prefilled.value : null) ??
        (from === 'draft' && homeValue?.draft ? prefillIntake(homeValue.draft.intake) : null) ??
        prefillIntake(homeValue?.lastIntake ?? null);
      // Replace the blank state wholesale: a reducer action per field would
      // flash the empty form first.
      dispatch({ type: 'restore', state: keepSuitableGoal(start, body) });
      setReady(true);
    });

    return () => {
      cancelled = true;
    };
  }, [from]);

  const generate = useCallback((): void => {
    const request = buildRequest(state);
    if (!request.ok) {
      setNotice({ tone: 'warn', text: request.errors.join(' ') });
      return;
    }
    setBusy(true);
    setNotice(null);
    writeSession(state);
    workoutsApi
      .startDraft(request.value)
      .then(() => {
        router.push('/portal/workouts/draft');
      })
      .catch((caught: unknown) => {
        setBusy(false);
        if (isQuotaExhausted(caught) && context.quota !== null) {
          setNotice({
            tone: 'warn',
            text: limitNotice(
              { ...context.quota, remaining: 0 },
              caught instanceof Error ? caught.message : null,
            ),
          });
          return;
        }
        const code = (caught as { code?: string }).code;
        if (code === 'WORKOUT_DRAFT_RUNNING') {
          setNotice({
            tone: 'warn',
            text: (
              <>
                {workoutErrorMessage(caught)}{' '}
                <Link href="/portal/workouts/draft" className="font-semibold underline">
                  Open it
                </Link>
                .
              </>
            ),
          });
          return;
        }
        setNotice({ tone: 'danger', text: workoutErrorMessage(caught) });
      });
  }, [context.quota, router, state]);

  if (!ready) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading the planner">
        <Skeleton height={60} />
        <Skeleton height={420} />
      </div>
    );
  }

  const facts = gymFacts(context.progress, context.checkIns, context.bookings);
  const problem = state.attempted ? stepProblem(state, state.step) : null;

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @4xl:gap-7">
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
              New workout plan
            </h1>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <span className="text-[12.5px] font-bold text-ink-3 @2xl:hidden">{state.step}/4</span>
            <QuotaPill quota={context.quota} />
          </div>
        </div>

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 @4xl:grid-cols-[minmax(0,1fr)_360px] @4xl:gap-7">
          <Panel
            aria-labelledby="wk-step-h"
            className="flex flex-col gap-5 px-4 pt-4 pb-0 max-[900px]:overflow-visible @2xl:gap-6 @2xl:px-7 @2xl:pt-6 @2xl:pb-7"
          >
            <IntakeSteps state={state} onGoTo={(step) => dispatch({ type: 'goto', step })} />

            {state.step === 1 ? (
              <GoalStep
                state={state}
                problem={problem}
                dispatch={dispatch}
                body={context.body}
              />
            ) : state.step === 2 ? (
              <AboutStep state={state} facts={facts} problem={problem} dispatch={dispatch} />
            ) : state.step === 3 ? (
              <WeekStep
                state={state}
                bookingHint={bookingHint(context.bookings)}
                problem={problem}
                dispatch={dispatch}
              />
            ) : (
              <HealthStep state={state} problem={problem} dispatch={dispatch} />
            )}

            {notice === null ? null : (
              <Notice tone={notice.tone} role="alert" icon={<IconWarning />}>
                {notice.text}
              </Notice>
            )}

            <div className="@4xl:hidden">
              <IntakeRail
                state={state}
                facts={facts}
                quota={context.quota}
                body={context.body}
              />
            </div>

            <IntakeFooter
              step={state.step}
              consent={state.consent}
              quota={context.quota}
              busy={busy}
              onBack={() => dispatch({ type: 'back' })}
              onNext={() => dispatch({ type: 'next' })}
              onGenerate={generate}
            />
          </Panel>

          <aside className="hidden @4xl:block">
            <IntakeRail
              state={state}
              facts={facts}
              quota={context.quota}
              body={context.body}
            />
          </aside>
        </div>
      </div>
    </div>
  );
}
