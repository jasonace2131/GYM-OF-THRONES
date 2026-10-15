'use client';

import { useState } from 'react';
import { currentValuePatch, formatHundredths, provenanceLabel } from '@/lib/progress/progressView';
import type { Goal, GoalPatch } from '@/lib/progress/types';
import { Badge } from '@/components/portal/ui';
import { ConfirmDelete } from './ConfirmDelete';

/**
 * Percent-done ring for a goal.
 *
 * NOT the portal's `ProgressRing`: that one is a DAYS-LEFT ring — it prints
 * "days left" under the number and turns red as the number falls, which is
 * right for a membership about to lapse and exactly backwards for a goal.
 * The old progress page used it anyway, so a half-done goal read "50 days
 * left" in a warning colour. This one reads "50% done" and only ever fills
 * in gold, turning green at 100.
 */
function GoalRing({ percent, size = 54 }: { percent: number; size?: number }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, percent));
  const tone = pct >= 100 ? 'var(--p-ok)' : 'var(--gold)';

  return (
    <div
      role="img"
      aria-label={`${pct}% done`}
      style={{ position: 'relative', width: size, height: size, flex: 'none' }}
    >
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }} aria-hidden>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="rgba(26,26,26,.08)"
          strokeWidth={stroke}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - pct / 100)}
        />
      </svg>
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-heading)',
          fontWeight: 800,
          fontSize: 13,
          color: 'var(--p-ink)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {pct}%
      </div>
    </div>
  );
}

/**
 * One goal. READ-ONLY unless `editable` — the member's page never passes it.
 *
 * On the coach's page a coach-recorded goal is `editable` and `removable`; a
 * self-recorded one is only `removable` (D2: frozen, deletable), and says so.
 */
export function GoalRow({
  goal,
  editable = false,
  removable = false,
  showProvenance = true,
  onPatch,
  onRemove,
}: {
  goal: Goal;
  editable?: boolean;
  removable?: boolean;
  showProvenance?: boolean;
  onPatch?: (patch: GoalPatch) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const provenance = showProvenance ? provenanceLabel(goal) : null;
  const selfRecorded = goal.recordedBy === null;
  const done = goal.achievedAt !== null;

  const patch = async (body: GoalPatch): Promise<void> => {
    if (onPatch === undefined) return;
    setBusy(true);
    setFailure(null);
    try {
      await onPatch(body);
    } catch (caught) {
      setFailure(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <GoalRing percent={goal.percent} />
        <div style={{ flex: '1 1 180px', minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 14.5,
              display: 'flex',
              gap: 8,
              alignItems: 'center',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{goal.name}</span>
            {done ? <Badge tone="ok">Done</Badge> : null}
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--p-ink3)' }}>
            {formatHundredths(goal.currentHundredths)} of {formatHundredths(goal.targetHundredths)}{' '}
            {goal.unit} · started at {formatHundredths(goal.startHundredths)}
          </div>
          {provenance === null ? null : (
            <div style={{ fontSize: 11.5, color: 'var(--p-ink3)', marginTop: 2 }}>
              {editable || !removable || !selfRecorded ? provenance : `${provenance} · read-only`}
            </div>
          )}
        </div>

        {editable || removable ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {editable ? (
              <>
                <input
                  // Keyed on the stored value, so a reload after a save (or a
                  // refused save) resets the box to what the server holds.
                  key={goal.currentHundredths}
                  className="a-input"
                  style={{ width: 96 }}
                  type="number"
                  inputMode="decimal"
                  step="0.1"
                  defaultValue={goal.currentHundredths / 100}
                  disabled={busy}
                  aria-label={`Current value for ${goal.name}, in ${goal.unit}`}
                  onBlur={(event) => {
                    const body = currentValuePatch(goal, event.target.value);
                    if (body !== null) void patch(body);
                  }}
                />
                <button
                  type="button"
                  className={`p-btn p-btn-sm ${done ? 'p-btn-ghost' : 'p-btn-gold'}`}
                  disabled={busy}
                  onClick={() => void patch({ achieved: !done })}
                >
                  {done ? 'Reopen' : 'Done'}
                </button>
              </>
            ) : null}
            {removable && onRemove !== undefined ? (
              <ConfirmDelete label={`the goal ${goal.name}`} disabled={busy} onConfirm={onRemove} />
            ) : null}
          </div>
        ) : null}
      </div>

      {failure === null ? null : (
        <p role="alert" style={{ margin: 0, fontSize: 13, color: 'var(--p-danger)' }}>
          {failure}
        </p>
      )}
    </div>
  );
}
