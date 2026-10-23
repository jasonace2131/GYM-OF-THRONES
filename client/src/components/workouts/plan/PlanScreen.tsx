'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type {
  MemberPlanBody,
  MemberPlanDay,
  MemberWorkoutPlanView,
  SwapAlternative,
  WorkoutAdjustPreset,
  WorkoutAiQuotaView,
  WorkoutIntakeSummary,
} from '@got/shared';
import { useIsPhone } from '@/lib/useMediaQuery';
import { workoutsApi } from '@/lib/workouts/api';
import { isQuotaExhausted, workoutErrorMessage } from '@/lib/workouts/errors';
import { formToBody, planToForm, type PlanForm } from '@/lib/workouts/handEdit';
import { PRESET_LABEL } from '@/lib/workouts/labels';
import {
  applyAdjust,
  applySwap,
  beginEdit,
  commitEdit,
  freshHistory,
  undoEdit,
  type EditHistory,
} from '@/lib/workouts/planEdits';
import { adjustedSummary } from '@/lib/workouts/planView';
import { limitNotice } from '@/lib/workouts/quota';
import { IconWarning } from '../icons';
import { Notice } from '../ui';
import { SafetyLine } from '../SafetyLine';
import { DayCard } from './DayCard';
import { HandEditor } from './HandEditor';
import type { GuideState } from './HowToPanel';
import { PlanHeader } from './PlanHeader';
import { PlanRail } from './PlanRail';
import type { SwapState } from './SwapPanel';
import { SwapSheet } from './SwapSheet';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

/**
 * The plan screen (Plan.dc.html), in two modes.
 *
 * SAVED: the full toolbelt. Swap fetches three alternatives (1 AI action,
 * cached per exercise so reopening is free), "Use this" applies the swap
 * locally AND PUTs the body, and Undo PUTs the previous body back. Adjust
 * fetches a replacement day (1 action) and shows it with Keep (PUT) / Undo
 * (local). Edit by hand validates with the shared parser before PUT. One
 * previous body is kept, until the next action replaces it.
 *
 * DRAFT: the same screen with How to only — Swap, Adjust and hand edits need
 * a saved plan id, and `POST /plans` saves the server's READY draft, so a
 * local edit before saving would be lost. The header says so.
 *
 * The body on screen is `history.current`; the prop is only the starting
 * point, so the parent keys this component by plan id.
 */

interface OpenPanel {
  kind: 'how' | 'swap';
  weekday: number;
  index: number;
  name: string;
}

export interface PlanScreenProps {
  mode: 'draft' | 'saved';
  planId: string | null;
  name: string;
  intake: WorkoutIntakeSummary;
  body: MemberPlanBody;
  meta: Pick<MemberWorkoutPlanView, 'source' | 'createdAt' | 'updatedAt'> | null;
  isActive: boolean;
  quota: WorkoutAiQuotaView | null;
  onQuota: (quota: WorkoutAiQuotaView) => void;
  /** Weekday → "Spin class · 6:00 PM (booked)" for the rail. */
  classes: Record<number, string>;
  /** `#day-<weekday>`: scroll to and briefly highlight that day. */
  focusWeekday: number | null;
  /** `?adjust=<weekday>`: open that day's adjust bar. */
  adjustWeekday: number | null;
  regenerateHref: string;
  onBodySaved?: (view: MemberWorkoutPlanView) => void;
  /** Draft mode's save form (desktop inline, phone sticky). */
  save?: ReactNode;
  /**
   * "Start this day" for a day card (feat/workout-sessions). Not offered on a
   * day with an adjustment that is not kept yet: the session would start the
   * SAVED day, not the one on screen.
   */
  renderStart?: (day: MemberPlanDay) => ReactNode;
}

const swapKey = (weekday: number, index: number, name: string): string =>
  `${weekday}:${index}:${name}`;

export function PlanScreen(props: PlanScreenProps) {
  const { mode, planId, quota, onQuota } = props;
  const isPhone = useIsPhone();
  // A lapsed member reads the plan: How to stays, Swap / Adjust / Start go.
  const canWrite = useMemberCanWrite();
  const saved = mode === 'saved' && planId !== null;
  const tools = saved && canWrite;

  const [history, setHistory] = useState<EditHistory>(() => freshHistory(props.body));
  const [open, setOpen] = useState<OpenPanel | null>(null);
  const [swaps, setSwaps] = useState<Record<string, SwapState>>({});
  const [guides, setGuides] = useState<Record<string, GuideState>>({});
  const [adjustOpen, setAdjustOpen] = useState<number | null>(props.adjustWeekday);
  const [activePreset, setActivePreset] = useState<Record<number, WorkoutAdjustPreset | null>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PlanForm | null>(null);
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [highlighted, setHighlighted] = useState<number | null>(props.focusWeekday);

  const current = history.current;
  const spendable = quota === null || quota.remaining > 0;
  const adjustDisabled = spendable ? null : 'No AI actions left today — they reset at midnight.';

  // `#day-<weekday>`: scroll there once, and let the gold ring fade.
  useEffect(() => {
    if (props.focusWeekday === null) return;
    const el = document.getElementById(`day-${props.focusWeekday}`);
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
    el?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => setHighlighted(null), 1600);
    return () => window.clearTimeout(timer);
  }, [props.focusWeekday]);

  const fail = useCallback(
    (caught: unknown): void => {
      if (isQuotaExhausted(caught) && quota !== null) {
        setNotice(
          limitNotice({ ...quota, remaining: 0 }, caught instanceof Error ? caught.message : null),
        );
        return;
      }
      setNotice(workoutErrorMessage(caught));
    },
    [quota],
  );

  const persist = useCallback(
    async (next: MemberPlanBody): Promise<void> => {
      if (planId === null) return;
      const view = await workoutsApi.putBody(planId, next);
      props.onBodySaved?.(view);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onBodySaved is a stable parent callback
    [planId],
  );

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

  const toggleHow = (weekday: number, index: number, name: string): void => {
    if (open?.kind === 'how' && open.weekday === weekday && open.index === index) {
      setOpen(null);
      return;
    }
    setOpen({ kind: 'how', weekday, index, name });
    if (guides[name] === undefined) loadGuide(name);
  };

  /* ── Swap (1 AI action per exercise, cached) ───────────────────── */

  const loadSwap = useCallback(
    (weekday: number, index: number, name: string): void => {
      if (planId === null) return;
      const key = swapKey(weekday, index, name);
      if (!spendable) {
        setSwaps((prev) => ({
          ...prev,
          [key]: { kind: 'error', message: adjustDisabled ?? 'No AI actions left today.' },
        }));
        return;
      }
      setSwaps((prev) => ({ ...prev, [key]: { kind: 'loading' } }));
      workoutsApi
        .swap(planId, { weekday, index })
        .then((res) => {
          onQuota(res.quota);
          setSwaps((prev) => ({
            ...prev,
            [key]: { kind: 'ready', alternatives: res.alternatives },
          }));
        })
        .catch((caught: unknown) => {
          const message =
            isQuotaExhausted(caught) && quota !== null
              ? limitNotice(
                  { ...quota, remaining: 0 },
                  caught instanceof Error ? caught.message : null,
                )
              : workoutErrorMessage(caught);
          setSwaps((prev) => ({ ...prev, [key]: { kind: 'error', message } }));
        });
    },
    [adjustDisabled, onQuota, planId, quota, spendable],
  );

  const toggleSwap = (weekday: number, index: number, name: string): void => {
    if (open?.kind === 'swap' && open.weekday === weekday && open.index === index) {
      setOpen(null);
      return;
    }
    setOpen({ kind: 'swap', weekday, index, name });
    if (swaps[swapKey(weekday, index, name)] === undefined) loadSwap(weekday, index, name);
  };

  const useAlternative = (alternative: SwapAlternative): void => {
    if (open === null || open.kind !== 'swap') return;
    const { weekday, index, name } = open;
    const next = applySwap(current, weekday, index, alternative);
    const before = history;
    const after = beginEdit(commitEdit(history), next, {
      kind: 'swap',
      weekday,
      index,
      from: name,
      to: alternative.name,
    });
    setHistory(after);
    setOpen(null);
    setNotice(null);
    setBusy(true);
    persist(next)
      .catch((caught: unknown) => {
        setHistory(before);
        fail(caught);
      })
      .finally(() => setBusy(false));
  };

  const undoSwap = (): void => {
    if (history.pending?.kind !== 'swap' || history.previous === null) return;
    const previous = history.previous;
    setBusy(true);
    setNotice(null);
    persist(previous)
      .then(() => setHistory(undoEdit(history)))
      .catch(fail)
      .finally(() => setBusy(false));
  };

  /* ── Adjust a day (1 AI action; Keep = PUT, Undo = local) ──────── */

  const adjust = (
    weekday: number,
    body: { preset: WorkoutAdjustPreset } | { request: string },
  ): void => {
    if (planId === null || !spendable) return;
    const label = 'preset' in body ? PRESET_LABEL[body.preset] : `“${body.request}”`;
    setBusy(true);
    setNotice(null);
    workoutsApi
      .adjust(planId, { weekday, ...body })
      .then((res) => {
        onQuota(res.quota);
        const next = applyAdjust(current, res.day);
        setHistory(
          beginEdit(commitEdit(history), next, {
            kind: 'adjust',
            weekday,
            summary: adjustedSummary(label, res.day),
          }),
        );
        setActivePreset((prev) => ({ ...prev, [weekday]: 'preset' in body ? body.preset : null }));
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const keepAdjust = (): void => {
    if (history.pending?.kind !== 'adjust') return;
    const weekday = history.pending.weekday;
    setBusy(true);
    setNotice(null);
    persist(current)
      .then(() => {
        setHistory(commitEdit(history));
        setActivePreset((prev) => ({ ...prev, [weekday]: null }));
      })
      .catch(fail)
      .finally(() => setBusy(false));
  };

  const undoAdjust = (): void => {
    if (history.pending?.kind !== 'adjust') return;
    const weekday = history.pending.weekday;
    setHistory(undoEdit(history));
    setActivePreset((prev) => ({ ...prev, [weekday]: null }));
  };

  /* ── Edit by hand ──────────────────────────────────────────────── */

  const startEdit = (): void => {
    setForm(planToForm(current));
    setFormErrors([]);
    setEditing(true);
    setOpen(null);
  };

  const saveEdit = (): void => {
    if (form === null) return;
    const result = formToBody(form);
    if (!result.ok) {
      setFormErrors(result.errors);
      return;
    }
    setFormErrors([]);
    setBusy(true);
    setNotice(null);
    persist(result.value)
      .then(() => {
        setHistory(freshHistory(result.value));
        setEditing(false);
        setForm(null);
      })
      .catch((caught: unknown) => {
        const code = (caught as { code?: string }).code;
        if (code === 'WORKOUT_PLAN_INVALID' && caught instanceof Error) {
          // The server lists each broken path in `details.errors`; the message
          // alone is the one-line fallback.
          const details = (caught as { details?: { errors?: unknown } }).details;
          const listed = Array.isArray(details?.errors)
            ? details.errors.filter((e): e is string => typeof e === 'string')
            : [];
          setFormErrors(listed.length > 0 ? listed : [caught.message]);
          return;
        }
        fail(caught);
      })
      .finally(() => setBusy(false));
  };

  /* ── Render ────────────────────────────────────────────────────── */

  const swappedFor = (weekday: number): number | null =>
    history.pending?.kind === 'swap' && history.pending.weekday === weekday
      ? history.pending.index
      : null;
  const adjustedFor = (weekday: number): string | null =>
    history.pending?.kind === 'adjust' && history.pending.weekday === weekday
      ? history.pending.summary
      : null;

  const openSwapState =
    open?.kind === 'swap' ? (swaps[swapKey(open.weekday, open.index, open.name)] ?? null) : null;

  return (
    <div className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 @3xl:gap-[22px]">
        <PlanHeader
          name={props.name}
          intake={props.intake}
          meta={props.meta}
          isActive={props.isActive}
          mode={mode}
          editing={editing}
          busy={busy}
          regenerateHref={props.regenerateHref}
          onEdit={startEdit}
          save={props.save}
        />

        {mode === 'draft' ? (
          <p className="m-0 text-[13px] text-ink-2">
            Save it to unlock Swap, Adjust this day and hand edits. How to is free right now.
          </p>
        ) : null}

        {notice === null ? null : (
          <Notice tone="warn" role="alert" icon={<IconWarning />}>
            {notice}
          </Notice>
        )}

        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_330px] @3xl:gap-[22px]">
          <div className="flex flex-col gap-4 @3xl:gap-[22px]">
            {editing && form !== null ? (
              <HandEditor
                form={form}
                errors={formErrors}
                busy={busy}
                onChange={setForm}
                onSave={saveEdit}
                onCancel={() => {
                  setEditing(false);
                  setForm(null);
                  setFormErrors([]);
                }}
              />
            ) : (
              current.days.map((day, i) => (
                <DayCard
                  key={day.weekday}
                  index={i}
                  day={day}
                  highlighted={highlighted === day.weekday}
                  toolbelt={tools ? 'full' : 'howOnly'}
                  busy={busy}
                  open={
                    open !== null && open.weekday === day.weekday
                      ? { kind: open.kind, index: open.index }
                      : null
                  }
                  inlineSwap={!isPhone}
                  swapState={open?.weekday === day.weekday ? openSwapState : null}
                  guideFor={(name) => guides[name] ?? null}
                  swappedIndex={swappedFor(day.weekday)}
                  adjusted={adjustedFor(day.weekday)}
                  activePreset={activePreset[day.weekday] ?? null}
                  adjustDisabled={adjustDisabled}
                  showAdjust={tools && (adjustOpen === null || adjustOpen === day.weekday)}
                  onHow={(index) => toggleHow(day.weekday, index, day.exercises[index]?.name ?? '')}
                  onSwap={(index) =>
                    toggleSwap(day.weekday, index, day.exercises[index]?.name ?? '')
                  }
                  onUse={useAlternative}
                  onRetrySwap={() => {
                    if (open?.kind === 'swap') loadSwap(open.weekday, open.index, open.name);
                  }}
                  onRetryGuide={loadGuide}
                  onUndoSwap={undoSwap}
                  onPreset={(preset) => {
                    setAdjustOpen(null);
                    adjust(day.weekday, { preset });
                  }}
                  onRequest={(request) => {
                    setAdjustOpen(null);
                    adjust(day.weekday, { request });
                  }}
                  onKeep={keepAdjust}
                  onUndoAdjust={undoAdjust}
                  startSlot={
                    adjustedFor(day.weekday) === null ? props.renderStart?.(day) : undefined
                  }
                />
              ))
            )}
          </div>

          <PlanRail plan={current} classes={props.classes} />
        </div>

        <SafetyLine />
      </div>

      {isPhone ? (
        <SwapSheet
          original={open?.kind === 'swap' ? open.name : null}
          state={openSwapState}
          quota={quota}
          busy={busy}
          onUse={useAlternative}
          onRetry={() => {
            if (open?.kind === 'swap') loadSwap(open.weekday, open.index, open.name);
          }}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </div>
  );
}
