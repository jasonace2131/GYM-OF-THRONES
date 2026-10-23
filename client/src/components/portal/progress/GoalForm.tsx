'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { goalBody, goalProblem, type GoalForm as FormValues } from '@/lib/progress/progressView';
import type { GoalBody } from '@/lib/progress/types';
import { GOAL_VALUE_LIMIT, blockExponentKeys } from '@/lib/numberInput';

const EMPTY: FormValues = { name: '', unit: 'kg', start: '', target: '' };
const fieldLabel = { display: 'grid', gap: 5, flex: '1 1 110px', minWidth: 0 } as const;

/**
 * Set a goal for the member. Free-form on purpose — "bench 100kg", "lose 5kg"
 * and "come 12 times this month" are the same shape — and a new goal starts
 * where the member is now, so there is no "current" box here.
 *
 * Legacy markup only: this folder is not Tailwind-scanned.
 */
export function GoalForm({ onSave }: { onSave: (body: GoalBody) => Promise<void> }) {
  const [values, setValues] = useState<FormValues>(EMPTY);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = goalProblem(values);
  const started = values.name !== '' || values.start !== '' || values.target !== '';

  const set = (key: keyof FormValues) => (event: { target: { value: string } }) =>
    setValues({ ...values, [key]: event.target.value });

  const submit = async (): Promise<void> => {
    if (problem !== null) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(goalBody(values));
      setValues(EMPTY);
    } catch (caught) {
      setFailure(caught instanceof ApiError ? caught.message : 'That did not save. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const shown =
    failure ?? (started && values.start !== '' && values.target !== '' ? problem : null);

  return (
    <form
      className="a-sheet"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="a-person-sub">GOAL</span>
        <input
          className="a-input"
          value={values.name}
          maxLength={80}
          placeholder="Lose weight, bench press, visits this month…"
          disabled={busy}
          onChange={set('name')}
        />
      </label>

      <div className="a-toolbar" style={{ alignItems: 'flex-end' }}>
        <label style={fieldLabel}>
          <span className="a-person-sub">FROM</span>
          <input
            className="a-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min={-GOAL_VALUE_LIMIT}
            max={GOAL_VALUE_LIMIT}
            onKeyDown={blockExponentKeys}
            value={values.start}
            disabled={busy}
            onChange={set('start')}
          />
        </label>
        <label style={fieldLabel}>
          <span className="a-person-sub">TO</span>
          <input
            className="a-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min={-GOAL_VALUE_LIMIT}
            max={GOAL_VALUE_LIMIT}
            onKeyDown={blockExponentKeys}
            value={values.target}
            disabled={busy}
            onChange={set('target')}
          />
        </label>
        <label style={fieldLabel}>
          <span className="a-person-sub">UNIT</span>
          <input
            className="a-input"
            value={values.unit}
            maxLength={12}
            disabled={busy}
            onChange={set('unit')}
          />
        </label>
      </div>

      {shown === null ? null : (
        <p role="alert" style={{ margin: 0, fontSize: 13.5, color: 'var(--p-danger)' }}>
          {shown}
        </p>
      )}

      <div>
        <button type="submit" className="p-btn p-btn-gold" disabled={busy || problem !== null}>
          {busy ? 'Saving…' : 'Add goal'}
        </button>
      </div>
    </form>
  );
}
