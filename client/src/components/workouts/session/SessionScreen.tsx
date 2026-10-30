'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { WorkoutSessionView } from '@got/shared';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { workoutsApi } from '@/lib/workouts/api';
import {
  isApiError,
  isOffline,
  isSessionEmpty,
  isSessionGone,
  workoutErrorMessage,
} from '@/lib/workouts/errors';
import { summaryHref } from '@/lib/workouts/history';
import { extendRest, startRest, type RestState } from '@/lib/workouts/restTimer';
import {
  clearSessionCache,
  readSessionCache,
  stashSummary,
  writeSessionCache,
} from '@/lib/workouts/sessionCache';
import {
  addSet,
  applyOps,
  exerciseCard,
  goTo,
  hasDone,
  initSession,
  leftOpen,
  nextSetNumber,
  offersFinish,
  parseRepsInput,
  progress,
  segments,
  setReps,
  startedLabel,
  stepReps,
  toView,
  toggleSet,
  type Change,
  type SessionModel,
} from '@/lib/workouts/sessionState';
import { cn } from '@/lib/utils';
import { IconCheck, IconSpinner, IconWarning } from '../icons';
import type { GuideState } from '../plan/HowToPanel';
import { Bone, buttonClass } from '../ui';
import { BarNotice, EndBar, StepBar } from './bars';
import { ElapsedClock } from './ElapsedClock';
import { ExerciseCard } from './ExerciseCard';
import { FocusOverlay } from './FocusOverlay';
import { RestBar } from './RestBar';
import { SegmentBar } from './SegmentBar';
import { sharedSyncQueue, useSyncQueue } from './useSyncQueue';
import { useWakeLock } from './useWakeLock';

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'none' }
  | { kind: 'ended' }
  | { kind: 'failed'; message: string };

const HUB = '/portal/workouts';
const OFFLINE_FINISH =
  'No signal right now. Every set is saved on this phone — finish when you are back online.';
const COLUMN = 'mx-auto w-full max-w-[560px]';

/**
 * `/portal/workouts/session` — one exercise at a time (PhoneSession.dc.html).
 *
 * The server's open session is the starting point; this phone's unsent sets
 * (the sync queue) are replayed over it, and the whole thing is cached after
 * every change so that a reload with no signal reopens it — same exercise,
 * same rest. Every tick goes to the queue first and the server second.
 */
export function SessionScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [view, setView] = useState<WorkoutSessionView | null>(null);
  const [model, setModelState] = useState<SessionModel | null>(null);
  const modelRef = useRef<SessionModel | null>(null);
  const [rest, setRest] = useState<RestState | null>(null);
  const [howOpen, setHowOpen] = useState(false);
  const [guides, setGuides] = useState<Record<string, GuideState>>({});
  const [end, setEnd] = useState<'finish' | 'discard' | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [restOver, setRestOver] = useState('');
  /** "Started Wed, Sep 30" when the workout was left open (`leftOpen`), else null. */
  const [openSince, setOpenSince] = useState<string | null>(null);
  const main = useRef<HTMLDivElement>(null);

  const setModel = useCallback((next: SessionModel): void => {
    modelRef.current = next;
    setModelState(next);
  }, []);

  /** Server first; this phone's unsent sets on top. */
  const rebuild = useCallback(
    (session: WorkoutSessionView, current: number | null): SessionModel => {
      const base = initSession(session, current);
      const ops = sharedSyncQueue().opsFor(session.id);
      const built = applyOps(base, ops, new Date().toISOString());
      setView(session);
      setModel(built);
      return built;
    },
    [setModel],
  );

  /**
   * …and the cache (with its running rest) when there is no server. A workout
   * left open (`leftOpen`: an earlier day, or hours untouched) opens on Finish
   * or Discard, with its start date in place of a clock that ran all night.
   */
  const adopt = useCallback(
    (session: WorkoutSessionView, current: number | null, restAt: RestState | null): void => {
      const built = rebuild(session, current);
      const today = gymToday(new Date(), GYM_TIMEZONE);
      const stale = leftOpen(session, today, Date.now());
      setOpenSince(stale ? startedLabel(session, today) : null);
      setRest(stale ? null : restAt);
      if (stale) setEnd(hasDone(built) ? 'finish' : 'discard');
      setPhase({ kind: 'ready' });
    },
    [rebuild],
  );

  const load = useCallback((): void => {
    const cached = readSessionCache();
    workoutsApi.currentSession().then(
      ({ session }) => {
        if (session === null) {
          clearSessionCache();
          setPhase({ kind: 'none' });
          return;
        }
        const same = cached !== null && cached.view.id === session.id ? cached : null;
        adopt(session, same?.current ?? null, same?.rest ?? null);
      },
      (caught: unknown) => {
        // No signal (or a server fault): the phone's copy is good enough to train on.
        const serverSaidNo = isApiError(caught) && caught.status < 500;
        if (cached !== null && !serverSaidNo) {
          adopt(cached.view, cached.current, cached.rest);
          return;
        }
        setPhase({ kind: 'failed', message: workoutErrorMessage(caught) });
      },
    );
  }, [adopt]);

  /** The server refused a queued set for good: see what it actually has. */
  const resync = useCallback(async (): Promise<void> => {
    const open = modelRef.current;
    if (open === null) return;
    try {
      const { session } = await workoutsApi.currentSession();
      if (session === null || session.id !== open.id) {
        clearSessionCache();
        sharedSyncQueue().clear(open.id);
        setPhase({ kind: 'ended' });
        return;
      }
      // Same workout: take the server's sets, keep the exercise and the rest running.
      rebuild(session, open.current);
    } catch {
      // Still offline: keep going on what is on screen.
    }
  }, [rebuild]);

  const sync = useSyncQueue(view?.id ?? null, () => void resync());
  useWakeLock(phase.kind === 'ready');

  useEffect(() => {
    load();
  }, [load]);

  // The phone's copy, after every change.
  useEffect(() => {
    if (view === null || model === null || phase.kind !== 'ready') return;
    writeSessionCache({ view: toView(view, model), current: model.current, rest });
  }, [view, model, rest, phase.kind]);

  /* ── Sets ──────────────────────────────────────────────────────── */

  const change = (fn: (m: SessionModel) => Change): void => {
    const current = modelRef.current;
    if (current === null) return;
    const { model: next, op } = fn(current);
    if (next !== current) setModel(next);
    sync.add(op);
  };

  const toggle = (e: number, s: number): void => {
    const current = modelRef.current;
    if (current === null) return;
    const { model: next, op, done } = toggleSet(current, e, s, new Date().toISOString());
    setModel(next);
    sync.add(op);
    setNotice(null);
    if (!done) return;
    setRestOver('');
    // No rest after the exercise's last set: there is no next set to rest for.
    const exercise = next.exercises[e];
    const nextSet = nextSetNumber(next, e);
    setRest(
      exercise === undefined || nextSet === null
        ? null
        : startRest(Date.now(), exercise.restSeconds, e, nextSet),
    );
  };

  const move = (index: number): void => {
    const current = modelRef.current;
    if (current === null) return;
    setModel(goTo(current, index));
    setRest(null);
    setHowOpen(false);
    main.current?.scrollTo({ top: 0 });
  };

  /* ── How to (free, cached, shared) ─────────────────────────────── */

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

  /* ── End: finish or discard ────────────────────────────────────── */

  const finish = async (): Promise<void> => {
    const current = modelRef.current;
    if (current === null || view === null) return;
    if (!hasDone(current)) {
      setEnd('discard');
      return;
    }
    setBusy(true);
    setNotice(null);
    await sync.flush();
    if (sharedSyncQueue().pending(view.id) > 0) {
      setNotice(OFFLINE_FINISH);
      setBusy(false);
      return;
    }
    try {
      const summary = await workoutsApi.finishSession(view.id, {});
      stashSummary(summary);
      clearSessionCache();
      sharedSyncQueue().clear(view.id);
      router.replace(summaryHref(view.id, true));
    } catch (caught) {
      setBusy(false);
      if (isSessionEmpty(caught)) {
        setEnd('discard');
        return;
      }
      setNotice(isOffline(caught) ? OFFLINE_FINISH : workoutErrorMessage(caught));
    }
  };

  const discard = async (): Promise<void> => {
    if (view === null) return;
    setBusy(true);
    setNotice(null);
    try {
      await workoutsApi.discardSession(view.id);
    } catch (caught) {
      if (!isSessionGone(caught)) {
        setBusy(false);
        setNotice(
          isOffline(caught)
            ? 'No signal right now. Discard it when you are back online.'
            : workoutErrorMessage(caught),
        );
        return;
      }
    }
    clearSessionCache();
    sharedSyncQueue().clear(view.id);
    router.replace(HUB);
  };

  const onRestDone = useCallback((): void => {
    setRest(null);
    setRestOver('Rest over. Next set.');
  }, []);

  /* ── Render ────────────────────────────────────────────────────── */

  if (phase.kind !== 'ready' || view === null || model === null) {
    return <SessionStateScreen phase={phase} onRetry={load} />;
  }

  const e = model.current;
  const exercise = model.exercises[e];
  const copy = exerciseCard(model, e);
  const done = progress(model);
  const canFinish = offersFinish(model);
  const guide = exercise === undefined ? null : (guides[exercise.name] ?? null);

  return (
    <FocusOverlay labelledBy="wk-session-title">
      <header className="shrink-0 border-b border-border bg-card">
        <div
          className={cn(
            COLUMN,
            'grid h-14 grid-cols-[64px_minmax(0,1fr)_64px] items-center px-1.5',
          )}
        >
          <button
            type="button"
            aria-label="End workout"
            onClick={() => setEnd(hasDone(model) ? 'finish' : 'discard')}
            className="flex h-11 cursor-pointer items-center justify-center rounded-[10px] border-0 bg-transparent text-[14px] font-bold text-danger transition-colors hover:bg-danger-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold motion-reduce:transition-none"
          >
            End
          </button>
          <div className="flex min-w-0 flex-col items-center gap-px">
            <h1
              id="wk-session-title"
              className="m-0 max-w-full truncate font-display text-[16px] font-bold"
            >
              {view.dayTitle}
            </h1>
            {openSince === null ? (
              <ElapsedClock startedAt={view.startedAt} />
            ) : (
              <span className="font-display text-[12.5px] font-semibold text-ink-3">
                {openSince}
              </span>
            )}
          </div>
          <span className="text-center text-[13px] font-bold text-[color:var(--p-ink)]">
            <span aria-hidden>
              {e + 1}/{model.exercises.length}
            </span>
            <span className="sr-only">
              Exercise {e + 1} of {model.exercises.length}
            </span>
          </span>
        </div>
        <div className={cn(COLUMN, 'px-3 pb-2.5')}>
          <SegmentBar segments={segments(model)} size="header" />
        </div>
      </header>

      <div ref={main} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <main className={cn(COLUMN, 'flex flex-col gap-3 px-4 pt-3.5 pb-3')}>
          <ExerciseCard
            copy={copy}
            rows={model.rows[e] ?? []}
            howOpen={howOpen}
            guide={guide}
            onHow={() => {
              const name = exercise?.name;
              if (name === undefined) return;
              setHowOpen((open) => !open);
              if (guides[name] === undefined) loadGuide(name);
            }}
            onRetryGuide={() => {
              if (exercise !== undefined) loadGuide(exercise.name);
            }}
            onAddSet={() => {
              const current = modelRef.current;
              if (current !== null) setModel(addSet(current, e));
            }}
            onStepReps={(s, d) => change((m) => stepReps(m, e, s, d))}
            onTypeReps={(s, text) => {
              const parsed = parseRepsInput(text);
              if (parsed.ok) change((m) => setReps(m, e, s, parsed.value));
            }}
            onToggle={(s) => toggle(e, s)}
          />

          {copy.note === null ? null : (
            <p className="m-0 text-[12.5px] leading-[1.45] text-ink-2 italic">{copy.note}</p>
          )}

          <p
            role="status"
            className={cn(
              'm-0 flex items-center gap-1.5 text-[12.5px] font-semibold',
              sync.line.tone === 'ok'
                ? 'text-ok'
                : sync.line.tone === 'warn'
                  ? 'text-warn'
                  : 'text-ink-3',
            )}
          >
            {sync.line.tone === 'ok' ? (
              <IconCheck size={13} strokeWidth={2.6} />
            ) : sync.line.tone === 'warn' ? (
              <IconWarning size={14} />
            ) : (
              <IconSpinner size={13} className="motion-safe:animate-spin" />
            )}
            {sync.line.text}
          </p>
          <p className="sr-only" aria-live="polite">
            {restOver}
          </p>
        </main>
      </div>

      {notice === null ? null : <BarNotice>{notice}</BarNotice>}
      {end !== null ? (
        <EndBar
          mode={end}
          setsDone={done.setsDone}
          leftOpen={openSince}
          busy={busy}
          onCancel={() => setEnd(null)}
          onConfirm={() => void (end === 'finish' ? finish() : discard())}
        />
      ) : rest !== null ? (
        <RestBar
          rest={rest}
          finish={canFinish ? { busy, onFinish: () => void finish() } : null}
          onAdd={() => setRest((r) => (r === null ? r : extendRest(r, Date.now())))}
          onSkip={() => setRest(null)}
          onDone={onRestDone}
        />
      ) : (
        <StepBar
          isFirst={e === 0}
          isLast={e === model.exercises.length - 1}
          canFinish={canFinish}
          busy={busy}
          onPrev={() => move(e - 1)}
          onNext={() => move(e + 1)}
          onFinish={() => void finish()}
        />
      )}
    </FocusOverlay>
  );
}

/** Loading, nothing open, closed elsewhere, or could not load — still full screen. */
function SessionStateScreen({ phase, onRetry }: { phase: Phase; onRetry: () => void }) {
  if (phase.kind === 'loading' || phase.kind === 'ready') {
    return (
      <FocusOverlay labelledBy="wk-session-title">
        <header className="shrink-0 border-b border-border bg-card">
          <div className={cn(COLUMN, 'flex h-14 flex-col items-center justify-center gap-1.5')}>
            <h1 id="wk-session-title" className="sr-only">
              Loading your workout
            </h1>
            <Bone className="h-4 w-32" />
            <Bone className="h-3 w-12" />
          </div>
        </header>
        <div className={cn(COLUMN, 'flex flex-col gap-3 px-4 pt-3.5')} aria-busy="true">
          <Bone className="h-[360px] w-full rounded-[14px]" />
          <Bone className="h-4 w-2/3" />
        </div>
      </FocusOverlay>
    );
  }

  const copy =
    phase.kind === 'none'
      ? {
          title: 'No workout in progress',
          body: 'Start one from Today, or from any day of a plan.',
        }
      : phase.kind === 'ended'
        ? {
            title: 'This workout was closed',
            body: 'It was finished or discarded on another phone or tab.',
          }
        : { title: 'We could not open your workout', body: phase.message };

  return (
    <FocusOverlay labelledBy="wk-session-title">
      <div className={cn(COLUMN, 'flex flex-1 flex-col items-center justify-center gap-4 px-6')}>
        <div className="flex flex-col items-center gap-1.5 text-center">
          <h1 id="wk-session-title" className="m-0 font-display text-[22px] font-bold">
            {copy.title}
          </h1>
          <p className="m-0 max-w-[320px] text-[14px] leading-[1.5] text-ink-2">{copy.body}</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2.5">
          {phase.kind === 'failed' ? (
            <button type="button" className={buttonClass('ghost', 'sm')} onClick={onRetry}>
              Try again
            </button>
          ) : null}
          <Link href={HUB} className={buttonClass('gold', 'sm')}>
            Back to Workouts
          </Link>
        </div>
      </div>
    </FocusOverlay>
  );
}
