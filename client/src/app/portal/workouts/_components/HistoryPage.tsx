'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { WorkoutSessionSummary } from '@got/shared';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import { HistoryRow } from '@/components/workouts/RecentWorkouts';
import { IconArrowLeft } from '@/components/workouts/icons';
import { workoutsApi } from '@/lib/workouts/api';
import { workoutErrorMessage } from '@/lib/workouts/errors';

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ok'; sessions: WorkoutSessionSummary[] };

const HUB = '/portal/workouts';

/**
 * `/portal/workouts/history` — every finished workout, newest first (the
 * server's last 50), each opening its summary. The rows are the hub's Recent
 * workouts rows.
 */
export function HistoryPage() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  const read = useCallback((): void => {
    workoutsApi.sessions().then(
      (sessions) => setLoad({ kind: 'ok', sessions }),
      (caught: unknown) => setLoad({ kind: 'failed', message: workoutErrorMessage(caught) }),
    );
  }, []);

  useEffect(() => {
    read();
  }, [read]);

  return (
    <div className="@container">
      <div className="grid w-full max-w-[760px] grid-cols-[minmax(0,1fr)] gap-4">
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
            Workout history
          </h1>
        </div>

        {load.kind === 'loading' ? (
          <div className="grid gap-3" aria-busy="true" aria-label="Loading your workouts">
            <Skeleton height={320} />
          </div>
        ) : load.kind === 'failed' ? (
          <Card>
            <EmptyState
              title="We could not load your workouts"
              hint={load.message}
              action={
                <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={read}>
                  Try again
                </button>
              }
            />
          </Card>
        ) : load.sessions.length === 0 ? (
          <Card>
            <EmptyState
              title="No finished workouts yet"
              hint="Start one from Today or from any day of a plan. It shows up here when you finish."
              action={
                <Link href={HUB} className="p-btn p-btn-gold p-btn-sm">
                  Back to Workouts
                </Link>
              }
            />
          </Card>
        ) : (
          <section
            aria-label="Finished workouts"
            className="overflow-hidden rounded-[14px] border border-border bg-card"
          >
            <ul className="m-0 list-none p-0">
              {load.sessions.map((summary, i) => (
                <li
                  key={summary.id}
                  className={i === 0 ? undefined : 'border-t border-[rgba(26,26,26,0.06)]'}
                >
                  <HistoryRow summary={summary} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
