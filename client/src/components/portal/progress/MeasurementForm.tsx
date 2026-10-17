'use client';

import { useState } from 'react';
import { ApiError } from '@/lib/api';
import { formatCivilDate } from '@/lib/gymTime';
import {
  emptyMeasurementForm,
  measurementBody,
  measurementFormFrom,
  measurementPatch,
  measurementProblem,
  type MeasurementForm as FormValues,
} from '@/lib/progress/progressView';
import type { Measurement, MeasurementBody, MeasurementPatch } from '@/lib/progress/types';

/**
 * The coach's record and edit forms. Every decision — what the wire gets,
 * whether it may be saved — is in `progressView.ts`; this only holds the
 * strings a person types and shows the server's answer.
 *
 * Legacy markup only: this folder is not Tailwind-scanned.
 */

const fieldLabel = { display: 'grid', gap: 5, flex: '1 1 130px', minWidth: 0 } as const;

function describeFailure(caught: unknown): string {
  return caught instanceof ApiError ? caught.message : 'That did not save. Try again.';
}

function Fields({
  values,
  onChange,
  disabled,
  dateEditable,
  today,
}: {
  values: FormValues;
  onChange: (next: FormValues) => void;
  disabled: boolean;
  dateEditable: boolean;
  today: string;
}) {
  const set = (key: keyof FormValues) => (event: { target: { value: string } }) =>
    onChange({ ...values, [key]: event.target.value });

  return (
    <>
      <div className="a-toolbar" style={{ alignItems: 'flex-end' }}>
        <label style={fieldLabel}>
          <span className="a-person-sub">DATE</span>
          <input
            className="a-input"
            type="date"
            value={values.date}
            max={today}
            required
            disabled={disabled || !dateEditable}
            onChange={set('date')}
          />
        </label>
        <label style={fieldLabel}>
          <span className="a-person-sub">WEIGHT (KG)</span>
          <input
            className="a-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="20"
            max="400"
            value={values.weight}
            disabled={disabled}
            onChange={set('weight')}
          />
        </label>
        <label style={fieldLabel}>
          <span className="a-person-sub">HEIGHT (CM)</span>
          <input
            className="a-input"
            type="number"
            inputMode="decimal"
            step="0.5"
            min="50"
            max="250"
            value={values.height}
            disabled={disabled}
            onChange={set('height')}
          />
        </label>
        <label style={fieldLabel}>
          <span className="a-person-sub">BODY FAT (%)</span>
          <input
            className="a-input"
            type="number"
            inputMode="decimal"
            step="0.1"
            min="1"
            max="70"
            value={values.bodyFat}
            disabled={disabled}
            onChange={set('bodyFat')}
          />
        </label>
      </div>
      <label style={{ display: 'grid', gap: 5 }}>
        <span className="a-person-sub">NOTES OPTIONAL</span>
        <input
          className="a-input"
          value={values.notes}
          maxLength={500}
          disabled={disabled}
          placeholder="After leg day, before breakfast…"
          onChange={set('notes')}
        />
      </label>
    </>
  );
}

function Failure({ message }: { message: string | null }) {
  return message === null ? null : (
    <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13.5, margin: 0 }}>
      {message}
    </p>
  );
}

/** Record a day. Recording a day that already has an entry fills it in. */
export function MeasurementForm({
  today,
  onSave,
}: {
  /** The gym's civil day — the default date, and the latest one allowed. */
  today: string;
  onSave: (body: MeasurementBody) => Promise<void>;
}) {
  const [values, setValues] = useState<FormValues>(() => emptyMeasurementForm(today));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const problem = measurementProblem(values, today);
  // Only complain once something has been typed: an empty form is not wrong.
  const typed = values.weight !== '' || values.height !== '' || values.bodyFat !== '';

  const submit = async (): Promise<void> => {
    if (problem !== null) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(measurementBody(values));
      setValues(emptyMeasurementForm(today));
    } catch (caught) {
      setFailure(describeFailure(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="a-sheet"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Fields values={values} onChange={setValues} disabled={busy} dateEditable today={today} />

      <p style={{ margin: 0, fontSize: 12.5, color: 'var(--p-ink3)' }}>
        Recording a day that already has an entry adds to it — a height after the morning&rsquo;s
        weight keeps the weight.
      </p>

      <Failure message={typed && problem !== null ? problem : failure} />

      <div>
        <button type="submit" className="p-btn p-btn-gold" disabled={busy || problem !== null}>
          {busy ? 'Saving…' : 'Save reading'}
        </button>
      </div>
    </form>
  );
}

/** Correct one recorded day. The date is fixed: a wrong day is deleted and re-recorded. */
export function MeasurementEditForm({
  entry,
  today,
  onSave,
  onCancel,
}: {
  entry: Measurement;
  today: string;
  onSave: (patch: MeasurementPatch) => Promise<void>;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<FormValues>(() => measurementFormFrom(entry));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const { patch, problem } = measurementPatch(entry, values);
  const unchanged = Object.keys(patch).length === 0;

  const submit = async (): Promise<void> => {
    if (problem !== null || unchanged) return;
    setBusy(true);
    setFailure(null);
    try {
      await onSave(patch);
    } catch (caught) {
      setFailure(describeFailure(caught));
      setBusy(false);
    }
  };

  return (
    <form
      className="a-sheet"
      aria-label={`Edit the reading for ${formatCivilDate(entry.businessDate)}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Fields
        values={values}
        onChange={setValues}
        disabled={busy}
        dateEditable={false}
        today={today}
      />
      <Failure message={problem ?? failure} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="submit"
          className="p-btn p-btn-gold p-btn-sm"
          disabled={busy || problem !== null || unchanged}
        >
          {busy ? 'Saving…' : 'Save changes'}
        </button>
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
