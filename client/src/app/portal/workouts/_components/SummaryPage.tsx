'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import type { WorkoutFeeling, WorkoutSessionSummary } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { FinishScreen, FinishScreenLoading } from '@/components/workouts/history/FinishScreen';
import { NewBests, StatTiles, WhatYouDid } from '@/components/workouts/history/SummaryParts';
import { HISTORY_HREF } from '@/components/workouts/RecentWorkouts';
import { IconArrowLeft } from '@/components/workouts/icons';
import { Chip, Panel } from '@/components/workouts/ui';
import { workoutsApi } from '@/lib/workouts/api';
import { isApiError, isSessionGone, workoutErrorMessage } from '@/lib/workouts/errors';
import { feelingLabel, plainLine } from '@/lib/workouts/history';
import { stashSummary, stashedSummary } from '@/lib/workouts/sessionCache';
import { SESSION_HREF } from '@/lib/workouts/today';

type Failure = { kind: 'missing' } | { kind: 'open' } | { kind: 'error'; message: string };

/**
 * `/portal/workouts/history/[sessionId]` — one finished workout.
 *
 * `?just=1` (straight from Finish) is the full-screen "Workout done" of
 * PhoneFinish.dc.html with the feeling chips; otherwise a plain entry inside
 * the portal. The id is untrusted: the server answers anything not the
 * caller's with a 404, and a still-open workout with 409 WORKOUT_SESSION_OPEN.
 */
export function SummaryPage() {
  const params = useParams<{ sessionId: string }>();
  const id = params.sessionId;
  const just = useSearchParams().get('just') === '1';

  const [summary, setSummary] = useState<WorkoutSessionSummary | null>(() => stashedSummary(id));
  const [failure, setFailure] = useState<Failure | null>(null);
  const [feelingBusy, setFeelingBusy] = useState(false);
  const [feelingError, setFeelingError] = useState<string | null>(null);

  const read = useCallback((): void => {
    workoutsApi.summary(id).then(
      (next) => {
        setFailure(null);
        setSummary(next);
      },
      (caught: unknown) => {
        if (isApiError(caught) && caught.code === 'WORKOUT_SESSION_OPEN') {
          setFailure({ kind: 'open' });
        } else if (isSessionGone(caught)) {
          setFailure({ kind: 'missing' });
        } else {
          setFailure({ kind: 'error', message: workoutErrorMessage(caught) });
        }
      },
    );
  }, [id]);

  useEffect(() => {
    // Straight from Finish, the summary is already here; a reload reads it.
    if (stashedSummary(id) === null) read();
  }, [id, read]);

  const saveFeeling = (feeling: WorkoutFeeling): void => {
    if (summary === null) return;
    const before = summary;
    setSummary({ ...summary, feeling });
    setFeelingBusy(true);
    setFeelingError(null);
    workoutsApi
      .patchSession(summary.id, { feeling })
      .then((saved) => {
        setSummary(saved);
        stashSummary(saved);
      })
      .catch((caught: unknown) => {
        setSummary(before);
        setFeelingError(workoutErrorMessage(caught));
      })
      .finally(() => setFeelingBusy(false));
  };

  if (failure !== null) {
    const copy =
      failure.kind === 'open'
        ? {
            title: 'This workout is still open',
            hint: 'Finish it first — then its summary lives here.',
          }
        : failure.kind === 'missing'
          ? {
              title: 'That is not one of your workouts',
              hint: 'It may have been discarded, or the link is wrong.',
            }
          : { title: 'We could not load this workout', hint: failure.message };
    return (
      <Card>
        <EmptyState
          title={copy.title}
          hint={copy.hint}
          action={
            <div className="flex flex-wrap justify-center gap-2.5">
              {failure.kind === 'error' ? (
                <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={read}>
                  Try again
                </button>
              ) : null}
              <Link
                href={failure.kind === 'open' ? SESSION_HREF : HISTORY_HREF}
                className="p-btn p-btn-gold p-btn-sm"
              >
                {failure.kind === 'open' ? 'Continue workout' : 'Workout history'}
              </Link>
            </div>
          }
        />
      </Card>
    );
  }

  if (summary === null) {
    return just ? (
      <FinishScreenLoading />
    ) : (
      <div className="grid gap-5" aria-busy="true" aria-label="Loading your workout">
        <Skeleton height={60} />
        <Skeleton height={180} />
        <Skeleton height={240} />
      </div>
    );
  }

  if (just) {
    return (
      <FinishScreen
        summary={summary}
        feelingBusy={feelingBusy}
        feelingError={feelingError}
        onFeeling={saveFeeling}
      />
    );
  }

  return (
    <div className="@container">
      <div className="grid w-full max-w-[760px] grid-cols-[minmax(0,1fr)] gap-4">
        <div className="flex min-w-0 items-center gap-2 @2xl:gap-3.5">
          <Link
            href={HISTORY_HREF}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-ink-2 no-underline hover:bg-paper-3 @2xl:h-9 @2xl:w-auto @2xl:gap-1.5 @2xl:pr-2.5 @2xl:pl-1.5"
            aria-label="Back to workout history"
          >
            <IconArrowLeft />
            <span className="hidden text-[14px] font-medium @2xl:inline">History</span>
          </Link>
          <span aria-hidden className="hidden text-[#c7c3bc] @2xl:inline">
            /
          </span>
          <h1 className="m-0 truncate font-display text-[17px] font-bold @2xl:text-[20px]">
            {summary.dayTitle}
          </h1>
        </div>

        <Panel className="flex flex-col gap-2.5 px-4 py-4 @2xl:px-6 @2xl:py-5">
          <h2 className="m-0 font-display text-[26px] leading-[1.1] font-extrabold @2xl:text-[30px]">
            {summary.dayTitle}
          </h2>
          <p className="m-0 text-[14px] text-ink-2">{plainLine(summary)}</p>
          {summary.feeling === null ? null : (
            <div>
              <Chip>Felt: {feelingLabel(summary.feeling)}</Chip>
            </div>
          )}
        </Panel>

        <StatTiles summary={summary} className="@2xl:grid-cols-4" />
        <NewBests summary={summary} />
        <WhatYouDid summary={summary} />
      </div>
    </div>
  );
}
