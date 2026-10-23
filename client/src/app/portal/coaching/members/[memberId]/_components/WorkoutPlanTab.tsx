'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS, WORKOUT_PLAN_LIMITS, type WorkoutPlanView } from '@got/shared';
import { ApiError } from '@/lib/api';
import { coachApi } from '@/lib/coachApi';
import {
  DAY_OPTIONS,
  OTHER_DAY,
  addDay,
  addExercise,
  dayChoice,
  draftFromPlan,
  draftToBody,
  emptyDraft,
  humanizeError,
  labelForChoice,
  removeDay,
  removeExercise,
  repeatedWeekdays,
  updateDay,
  updateExercise,
  validateDraft,
  type PlanDraft,
} from '@/lib/workoutPlan/editor';
import { usePermission } from '@/components/rbac/MeProvider';
import { PlanDays } from '@/components/coaching/PlanDays';
import { Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { filterIntTyping } from '@/lib/numberInput';

type Load = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ok'; view: WorkoutPlanView | null };

/**
 * The Workout plan tab (feat/coach-tools).
 *
 * "Suggest a plan" asks the server for an AI DRAFT built from this client's
 * goals, measurements and attendance, and loads it into the editor — nothing
 * is saved until the coach presses Save. The editor is plain inputs, no rich
 * text; every rule about what a plan may hold is `parseWorkoutPlan` from
 * @got/shared, the same check the server runs on the save.
 *
 * The suggestion draws on the gym's free AI allowance, which it SHARES with
 * members' questions to the assistant — the server's "busy" message says so.
 */
export function WorkoutPlanTab({ memberId }: { memberId: string }) {
  const canSuggest = usePermission(PERMISSIONS.WORKOUT_SUGGEST);
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [fromAi, setFromAi] = useState(false);
  const [busy, setBusy] = useState<'suggest' | 'save' | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [otherKeys, setOtherKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    coachApi.workoutPlan(memberId).then(
      (result) => {
        if (!cancelled) setLoad({ kind: 'ok', view: result.plan });
      },
      () => {
        if (!cancelled) setLoad({ kind: 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  const suggest = async (): Promise<void> => {
    setBusy('suggest');
    setFailure(null);
    setErrors([]);
    try {
      const { draft: suggestion } = await coachApi.suggestWorkoutPlan(memberId);
      setDraft(draftFromPlan(suggestion));
      setFromAi(true);
    } catch (caught) {
      setFailure(
        caught instanceof ApiError
          ? caught.message
          : 'The suggestion did not arrive. Try again, or write the plan yourself.',
      );
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;
    const checked = validateDraft(draft);
    if (!checked.ok) {
      setErrors(checked.errors.map(humanizeError));
      return;
    }
    setErrors([]);
    setFailure(null);
    setBusy('save');
    try {
      const view = await coachApi.saveWorkoutPlan(memberId, draftToBody(draft));
      setLoad({ kind: 'ok', view });
      setDraft(null);
      setFromAi(false);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'The plan did not save. Try again.');
    } finally {
      setBusy(null);
    }
  };

  if (load.kind === 'loading') return <Skeleton height={260} />;

  if (load.kind === 'failed') {
    return (
      <Card>
        <EmptyState
          title="Could not load the workout plan"
          hint="This is usually the network. Reload the page to try again."
        />
      </Card>
    );
  }

  const suggestButton = canSuggest ? (
    <button
      type="button"
      className="p-btn p-btn-ghost p-btn-sm"
      disabled={busy !== null}
      onClick={() => void suggest()}
    >
      {busy === 'suggest' ? 'Drafting…' : 'Suggest a plan'}
    </button>
  ) : null;

  const failureLine =
    failure === null ? null : (
      <p role="alert" style={{ margin: 0, fontSize: 13.5, color: 'var(--p-danger)' }}>
        {failure}
      </p>
    );

  // ── Viewing ───────────────────────────────────────────────────────────
  if (draft === null) {
    const view = load.view;
    return (
      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="Workout plan"
            action={
              <span style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {suggestButton}
                <button
                  type="button"
                  className="p-btn p-btn-gold p-btn-sm"
                  disabled={busy !== null}
                  onClick={() => {
                    setDraft(view === null ? emptyDraft() : draftFromPlan(view.plan));
                    setFromAi(false);
                    setErrors([]);
                    setFailure(null);
                  }}
                >
                  {view === null ? 'Write a plan' : 'Edit plan'}
                </button>
              </span>
            }
          />
        </div>
        <div className="p-card-pad" style={{ display: 'grid', gap: 14 }}>
          {failureLine}
          {view === null ? (
            <p className="p-muted" style={{ margin: 0 }}>
              No plan yet. Write one, or let the AI draft one from this client&apos;s goals,
              measurements and attendance for you to edit. The client sees it on their dashboard
              once you save.
            </p>
          ) : (
            <>
              <PlanDays plan={view.plan} />
              <p className="p-muted" style={{ margin: 0, fontSize: 12 }}>
                Saved{' '}
                {new Intl.DateTimeFormat('en-PH', {
                  timeZone: 'Asia/Manila',
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(view.updatedAt))}
                {view.coach === null ? '' : ` by ${view.coach.firstName} ${view.coach.lastName}`}
              </p>
            </>
          )}
        </div>
      </Card>
    );
  }

  // ── Editing ───────────────────────────────────────────────────────────
  const repeated = repeatedWeekdays(draft);
  /** A day the coach switched to "Other…" stays there while they type, even "Mon". */
  const choiceFor = (key: string, label: string): string =>
    otherKeys.has(key) ? OTHER_DAY : dayChoice(label);

  return (
    <Card padded={false}>
      <div style={{ padding: '18px 18px 0' }}>
        <CardHead
          title={fromAi ? 'Suggested plan — review before saving' : 'Edit workout plan'}
          action={suggestButton}
        />
      </div>
      <form
        className="p-card-pad"
        style={{ display: 'grid', gap: 16 }}
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {fromAi ? (
          <p
            style={{
              margin: 0,
              padding: '10px 12px',
              borderRadius: 9,
              background: 'var(--p-warn-bg)',
              color: 'var(--p-warn)',
              fontSize: 13,
            }}
          >
            This is an AI draft. It knows the client&apos;s goals, measurements and attendance — not
            injuries or anything they told you. Check every exercise; nothing is saved until you
            press Save.
          </p>
        ) : null}

        <label style={{ display: 'grid', gap: 5 }}>
          <span className="a-person-sub">SUMMARY FOR THE CLIENT</span>
          <textarea
            className="a-textarea"
            rows={3}
            maxLength={WORKOUT_PLAN_LIMITS.summaryMax}
            value={draft.summary}
            onChange={(event) => setDraft({ ...draft, summary: event.target.value })}
          />
        </label>

        {draft.days.map((day, dayIndex) => (
          <fieldset key={day.key} className="p-plan-day" style={{ margin: 0 }}>
            <legend className="sr-only">Day {dayIndex + 1}</legend>
            <div className="a-toolbar" style={{ alignItems: 'flex-end' }}>
              {/* The member's Today finds this day by its weekday, so the label
                  is picked, not typed — "Other…" keeps free text for plans
                  that are not tied to days of the week. */}
              <label style={{ display: 'grid', gap: 5, flex: '1 1 140px' }}>
                <span className="a-person-sub">DAY</span>
                <select
                  className="a-select"
                  value={choiceFor(day.key, day.day)}
                  onChange={(event) => {
                    const choice = event.target.value;
                    setOtherKeys((prev) => {
                      const next = new Set(prev);
                      if (choice === OTHER_DAY) next.add(day.key);
                      else next.delete(day.key);
                      return next;
                    });
                    setDraft(updateDay(draft, day.key, { day: labelForChoice(choice, day.day) }));
                  }}
                >
                  {DAY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              {choiceFor(day.key, day.day) === OTHER_DAY ? (
                <label style={{ display: 'grid', gap: 5, flex: '1 1 140px' }}>
                  <span className="a-person-sub">DAY NAME</span>
                  <input
                    className="a-input"
                    value={day.day}
                    maxLength={WORKOUT_PLAN_LIMITS.dayLabelMax}
                    placeholder="Day 1, Upper A…"
                    onChange={(event) =>
                      setDraft(updateDay(draft, day.key, { day: event.target.value }))
                    }
                  />
                </label>
              ) : null}
              <label style={{ display: 'grid', gap: 5, flex: '3 1 220px' }}>
                <span className="a-person-sub">FOCUS</span>
                <input
                  className="a-input"
                  value={day.focus}
                  maxLength={WORKOUT_PLAN_LIMITS.focusMax}
                  placeholder="Lower body, conditioning…"
                  onChange={(event) =>
                    setDraft(updateDay(draft, day.key, { focus: event.target.value }))
                  }
                />
              </label>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                disabled={draft.days.length <= 1}
                onClick={() => setDraft(removeDay(draft, day.key))}
                aria-label={`Remove ${day.day || `day ${dayIndex + 1}`}`}
              >
                Remove day
              </button>
            </div>

            {day.exercises.map((exercise, exerciseIndex) => (
              <div key={exercise.key} className="p-plan-ex">
                <label style={{ display: 'grid', gap: 5 }}>
                  <span className="a-person-sub">EXERCISE {exerciseIndex + 1}</span>
                  <input
                    className="a-input"
                    value={exercise.name}
                    maxLength={WORKOUT_PLAN_LIMITS.exerciseNameMax}
                    onChange={(event) =>
                      setDraft(
                        updateExercise(draft, day.key, exercise.key, { name: event.target.value }),
                      )
                    }
                  />
                </label>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span className="a-person-sub">SETS</span>
                  <input
                    className="a-input"
                    inputMode="numeric"
                    maxLength={String(WORKOUT_PLAN_LIMITS.setsMax).length}
                    value={exercise.sets}
                    onChange={(event) =>
                      setDraft(
                        updateExercise(draft, day.key, exercise.key, {
                          sets: filterIntTyping(event.target.value),
                        }),
                      )
                    }
                  />
                </label>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span className="a-person-sub">REPS</span>
                  <input
                    className="a-input"
                    value={exercise.reps}
                    maxLength={WORKOUT_PLAN_LIMITS.repsMax}
                    placeholder="8-10, 30s"
                    onChange={(event) =>
                      setDraft(
                        updateExercise(draft, day.key, exercise.key, { reps: event.target.value }),
                      )
                    }
                  />
                </label>
                <label style={{ display: 'grid', gap: 5 }}>
                  <span className="a-person-sub">NOTES</span>
                  <input
                    className="a-input"
                    value={exercise.notes}
                    maxLength={WORKOUT_PLAN_LIMITS.notesMax}
                    placeholder="Optional"
                    onChange={(event) =>
                      setDraft(
                        updateExercise(draft, day.key, exercise.key, { notes: event.target.value }),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  disabled={day.exercises.length <= 1}
                  onClick={() => setDraft(removeExercise(draft, day.key, exercise.key))}
                  aria-label={`Remove exercise ${exerciseIndex + 1}`}
                >
                  ✕
                </button>
              </div>
            ))}

            <div>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                disabled={day.exercises.length >= WORKOUT_PLAN_LIMITS.exercisesMax}
                onClick={() => setDraft(addExercise(draft, day.key))}
              >
                Add exercise
              </button>
            </div>
          </fieldset>
        ))}

        <div>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={draft.days.length >= WORKOUT_PLAN_LIMITS.daysMax}
            onClick={() => setDraft(addDay(draft))}
          >
            Add day
          </button>
        </div>

        {repeated.length > 0 ? (
          <p className="p-muted" style={{ margin: 0, fontSize: 13 }}>
            {repeated.join(' and ')} {repeated.length === 1 ? 'is' : 'are'} used for more than one
            day. The client&apos;s Today shows the first of them.
          </p>
        ) : null}

        {errors.length > 0 ? (
          <div role="alert" style={{ fontSize: 13, color: 'var(--p-danger)' }}>
            <p style={{ margin: '0 0 6px' }}>Fix these before saving:</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {errors.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {failureLine}

        <div className="a-toolbar">
          <button type="submit" className="p-btn p-btn-gold" disabled={busy !== null}>
            {busy === 'save' ? 'Saving…' : 'Save plan'}
          </button>
          <button
            type="button"
            className="p-btn p-btn-ghost"
            disabled={busy !== null}
            onClick={() => {
              setDraft(null);
              setFromAi(false);
              setErrors([]);
              setFailure(null);
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}
