'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { WorkoutAiQuotaView, WorkoutDraftView } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { DraftDayCard } from '@/components/workouts/draft/DraftDayCard';
import { ProgressCard } from '@/components/workouts/draft/ProgressCard';
import { PlanScreen } from '@/components/workouts/plan/PlanScreen';
import { SaveBar } from '@/components/workouts/plan/SaveBar';
import { QuotaPill } from '@/components/workouts/QuotaPill';
import { IconArrowLeft, IconInfo } from '@/components/workouts/icons';
import { buttonClass } from '@/components/workouts/ui';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { workoutsApi } from '@/lib/workouts/api';
import { dayCards } from '@/lib/workouts/draftProgress';
import { workoutErrorMessage } from '@/lib/workouts/errors';
import { planNameFor } from '@/lib/workouts/labels';
import { loadWeekBookings } from '@/lib/workouts/loadHub';
import { pollDraft, sleepMs, type StopReason } from '@/lib/workouts/polling';
import { bookedClassesByWeekday } from '@/lib/workouts/today';
import { INTAKE_SESSION_KEY } from './IntakeWizard';

/**
 * `/portal/workouts/draft` — generating → draft review → save
 * (Generating.dc.html, then Plan.dc.html in draft mode).
 *
 * Polls `GET /me/workouts/draft` every 800 ms through `pollDraft`, paints
 * each day as it lands, and stops on READY, FAILED, a 404 or 90 s. READY
 * becomes the plan screen with "Save to my plans"; FAILED shows the
 * server's member copy and Try again, which reopens the wizard with this
 * tab's answers.
 */

const EXPECTED_ROWS = 5;

function clearSession(): void {
  try {
    window.sessionStorage.removeItem(INTAKE_SESSION_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function DraftScreen() {
  const router = useRouter();
  const [draft, setDraft] = useState<WorkoutDraftView | null>(null);
  const [stop, setStop] = useState<StopReason | null>(null);
  const [quota, setQuota] = useState<WorkoutAiQuotaView | null>(null);
  const [classes, setClasses] = useState<Record<number, string>>({});
  const [cancelling, setCancelling] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<React.ReactNode | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [makeActive, setMakeActive] = useState(true);
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    void pollDraft({
      fetchDraft: workoutsApi.draft,
      onDraft: (next) => {
        if (!cancelled.current) setDraft(next);
      },
      sleep: sleepMs,
      now: () => Date.now(),
      isCancelled: () => cancelled.current,
    }).then((result) => {
      if (cancelled.current) return;
      if (result.draft !== null) setDraft(result.draft);
      setStop(result.reason);
    });

    const today = gymToday(new Date(), GYM_TIMEZONE);
    void workoutsApi
      .home()
      .then((home) => {
        if (!cancelled.current) setQuota(home.quota);
      })
      .catch(() => undefined);
    void loadWeekBookings(today)
      .then((bookings) => {
        if (!cancelled.current) setClasses(bookedClassesByWeekday(bookings, today, 'long'));
      })
      .catch(() => undefined);

    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (stop === 'MISSING') router.replace('/portal/workouts');
  }, [router, stop]);

  const cancel = useCallback((): void => {
    setCancelling(true);
    workoutsApi
      .discardDraft()
      .catch(() => undefined)
      .finally(() => {
        clearSession();
        router.replace('/portal/workouts');
      });
  }, [router]);

  const save = useCallback(
    (planName: string): void => {
      setSaving(true);
      setSaveError(null);
      workoutsApi
        .savePlan({ name: planName.trim(), makeActive })
        .then((view) => {
          clearSession();
          router.replace(`/portal/workouts/${encodeURIComponent(view.id)}`);
        })
        .catch((caught: unknown) => {
          setSaving(false);
          const code = (caught as { code?: string }).code;
          setSaveError(
            code === 'WORKOUT_PLAN_LIMIT' ? (
              <>
                {workoutErrorMessage(caught)}{' '}
                <Link href="/portal/workouts" className="font-semibold underline">
                  Go to your plans
                </Link>
                .
              </>
            ) : (
              workoutErrorMessage(caught)
            ),
          );
        });
    },
    [makeActive, router],
  );

  if (draft === null) {
    return (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your draft">
        <Skeleton height={60} />
        <Skeleton height={180} />
        <Skeleton height={320} />
      </div>
    );
  }

  const header = (
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
      <QuotaPill quota={quota} />
    </div>
  );

  if (draft.status === 'READY' && stop === 'READY') {
    const planName = name ?? planNameFor(draft.intake.goal, draft.intake.experience);
    const saveBar = (
      <SaveBar
        name={planName}
        makeActive={makeActive}
        busy={saving}
        error={saveError}
        onName={setName}
        onMakeActive={setMakeActive}
        onSave={() => save(planName)}
      />
    );
    return (
      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
          {header}
          <PlanScreen
            mode="draft"
            planId={null}
            name={planName}
            intake={draft.intake}
            body={{
              summary: draft.plan.summary ?? '',
              days: draft.plan.days,
              guidance: draft.plan.guidance ?? [],
            }}
            meta={null}
            isActive={false}
            quota={quota}
            onQuota={setQuota}
            classes={classes}
            focusWeekday={null}
            adjustWeekday={null}
            regenerateHref="/portal/workouts/new?from=draft"
            save={saveBar}
          />
          {/* `contents`: a wrapper the size of the bar gave the sticky bar no
              room to move, so it never stuck. Now its parent is the page grid. */}
          <div className="contents @3xl:hidden">{saveBar}</div>
        </div>
      </div>
    );
  }

  if (draft.status === 'FAILED' || stop === 'FAILED' || stop === 'TIMEOUT') {
    const message =
      draft.status === 'FAILED'
        ? (draft.error ?? 'The AI stopped part-way.')
        : 'This is taking longer than usual, so the draft was thrown away and your AI action given back.';
    return (
      <div className="@container">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
          {header}
          <Card>
            <EmptyState
              title="Your plan did not finish"
              hint={`${message} Nothing was saved and your AI action was given back.`}
              action={
                <div className="flex flex-wrap justify-center gap-2.5">
                  <Link
                    href="/portal/workouts/new?from=draft"
                    className={buttonClass('gold', 'sm')}
                  >
                    Try again
                  </Link>
                  <Link href="/portal/workouts" className={buttonClass('ghost', 'sm')}>
                    Back to Workouts
                  </Link>
                </div>
              }
            />
          </Card>
        </div>
      </div>
    );
  }

  const cards = dayCards(draft);
  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
        {header}
        <ProgressCard draft={draft} cancelling={cancelling} onCancel={cancel} />
        <div
          className="grid grid-cols-1 items-start gap-4 @2xl:grid-cols-2 @3xl:grid-cols-3 @3xl:gap-5"
          aria-live="polite"
        >
          {cards.map((card) => (
            <DraftDayCard key={card.weekday} card={card} expected={EXPECTED_ROWS} />
          ))}
        </div>
        <p className="m-0 flex items-start gap-2 text-[13px] leading-[1.45] text-ink-2">
          <IconInfo size={16} className="mt-px shrink-0" />
          Nothing is saved until you press Save. If the AI stops part-way, the draft is thrown away
          and your AI action is given back.
        </p>
      </div>
    </div>
  );
}
