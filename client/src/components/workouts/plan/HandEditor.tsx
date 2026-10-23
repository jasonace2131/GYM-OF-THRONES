import { WORKOUT_LIMITS } from '@got/shared';
import {
  addExercise,
  removeExercise,
  updateDay,
  updateExercise,
  type PlanForm,
} from '@/lib/workouts/handEdit';
import { dayKicker } from '@/lib/workouts/planView';
import { IconPlus, IconTrash, IconWarning } from '../icons';
import { Button, Notice, Panel, PlainButton } from '../ui';
import { filterIntTyping } from '@/lib/numberInput';

const FIELD =
  'h-10 min-w-0 rounded-lg border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3 text-[14px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold';

/**
 * "Edit by hand": every day's title and every exercise's name, muscles,
 * sets, reps, rest and notes as inputs, plus add/remove. Validation is
 * `parseMemberPlan` through `formToBody`; the errors it names are listed by
 * path above the form and Save is refused until they are fixed.
 */
export function HandEditor({
  form,
  errors,
  busy,
  onChange,
  onSave,
  onCancel,
}: {
  form: PlanForm;
  errors: string[];
  busy: boolean;
  onChange: (next: PlanForm) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      className="flex flex-col gap-4 @3xl:gap-5"
      aria-label="Edit the plan by hand"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      {errors.length === 0 ? null : (
        <Notice tone="warn" role="alert" icon={<IconWarning />}>
          <strong>Fix these before saving:</strong>
          <ul className="m-0 mt-1 pl-4">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </Notice>
      )}

      {form.days.map((day, di) => (
        <Panel key={day.weekday} className="flex flex-col gap-3 px-4 py-4 @2xl:px-[22px]">
          <span className="text-[11px] font-bold tracking-[0.14em] text-ink-3 uppercase">
            {dayKicker(di, day.weekday)}
          </span>
          <label className="flex flex-col gap-1 text-[12.5px] font-semibold text-ink-2">
            Day title
            <input
              type="text"
              value={day.title}
              maxLength={WORKOUT_LIMITS.titleMax}
              onChange={(e) => onChange(updateDay(form, di, { title: e.target.value }))}
              className={`${FIELD} font-display text-[16px] font-bold text-foreground`}
            />
          </label>
          <ol className="m-0 flex list-none flex-col gap-3 p-0">
            {day.exercises.map((exercise, ei) => (
              <li
                key={ei}
                className="grid grid-cols-1 gap-2 rounded-xl border border-border bg-[#fbfaf8] p-3 @2xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_64px_92px_72px_minmax(0,1fr)_40px] @2xl:items-end"
              >
                <Field label={`Exercise ${ei + 1}`}>
                  <input
                    type="text"
                    value={exercise.name}
                    maxLength={WORKOUT_LIMITS.exerciseNameMax}
                    onChange={(e) =>
                      onChange(updateExercise(form, di, ei, { name: e.target.value }))
                    }
                    className={FIELD}
                    aria-label={`Exercise ${ei + 1} name`}
                  />
                </Field>
                <Field label="Muscles">
                  <input
                    type="text"
                    value={exercise.muscles}
                    maxLength={WORKOUT_LIMITS.musclesMax}
                    onChange={(e) =>
                      onChange(updateExercise(form, di, ei, { muscles: e.target.value }))
                    }
                    className={FIELD}
                    aria-label={`Exercise ${ei + 1} muscles`}
                  />
                </Field>
                <div className="grid grid-cols-3 gap-2 @2xl:contents">
                  <Field label="Sets">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={exercise.sets}
                      maxLength={String(WORKOUT_LIMITS.setsMax).length}
                      onChange={(e) =>
                        onChange(
                          updateExercise(form, di, ei, { sets: filterIntTyping(e.target.value) }),
                        )
                      }
                      className={FIELD}
                      aria-label={`Exercise ${ei + 1} sets`}
                    />
                  </Field>
                  <Field label="Reps">
                    <input
                      type="text"
                      value={exercise.reps}
                      maxLength={WORKOUT_LIMITS.repsMax}
                      onChange={(e) =>
                        onChange(updateExercise(form, di, ei, { reps: e.target.value }))
                      }
                      className={FIELD}
                      aria-label={`Exercise ${ei + 1} reps`}
                    />
                  </Field>
                  <Field label="Rest (s)">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={exercise.restSeconds}
                      maxLength={String(WORKOUT_LIMITS.restSecondsMax).length}
                      onChange={(e) =>
                        onChange(
                          updateExercise(form, di, ei, {
                            restSeconds: filterIntTyping(e.target.value),
                          }),
                        )
                      }
                      className={FIELD}
                      aria-label={`Exercise ${ei + 1} rest in seconds`}
                    />
                  </Field>
                </div>
                <Field label="Notes">
                  <input
                    type="text"
                    value={exercise.notes}
                    maxLength={WORKOUT_LIMITS.notesMax}
                    onChange={(e) =>
                      onChange(updateExercise(form, di, ei, { notes: e.target.value }))
                    }
                    className={FIELD}
                    aria-label={`Exercise ${ei + 1} notes`}
                  />
                </Field>
                <button
                  type="button"
                  aria-label={`Remove exercise ${ei + 1}`}
                  disabled={day.exercises.length <= 1}
                  onClick={() => onChange(removeExercise(form, di, ei))}
                  className="flex h-10 w-10 cursor-pointer items-center justify-center justify-self-end rounded-lg border-[1.5px] border-[color:var(--p-border-2)] bg-card text-danger hover:border-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <IconTrash />
                </button>
              </li>
            ))}
          </ol>
          <PlainButton
            tone="ghost"
            className="self-start"
            disabled={day.exercises.length >= WORKOUT_LIMITS.exercisesMax}
            onClick={() => onChange(addExercise(form, di))}
          >
            <IconPlus />
            Add exercise
          </PlainButton>
        </Panel>
      ))}

      <div className="flex flex-wrap justify-end gap-2.5">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button variant="gold" size="sm" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-[11.5px] font-semibold tracking-[0.06em] text-ink-3 uppercase">
      {label}
      {children}
    </label>
  );
}
