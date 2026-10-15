'use client';

import { useCallback, useState } from 'react';
import { Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { adminApi, type DayHours } from '@/lib/adminApi';
import { hhmmTo12h } from '@/lib/gymTime';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { hoursChanges } from '@/lib/openingHoursChanges';
import { ConfirmDialog } from './actions/ConfirmDialog';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Editable opening hours.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HOURS USED TO BE STATED IN FOUR PLACES AND ENFORCED IN ONE.
 *
 * `GYM_OPEN_TIME`/`GYM_CLOSE_TIME` shut the door at 22:00 while the ticker,
 * the gallery caption and the footer all advertised 11pm — so a member
 * arriving at 22:30 was turned away by a system whose own website had told
 * them to come. This screen is now the single place that decides, and both
 * the door and the marketing copy read from it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The environment variables remain the FALLBACK, not a rival: if this table
 * cannot be read the gate uses them, so editing hours in a browser can never
 * leave the front desk stuck with no explanation.
 */
export function OpeningHoursCard({ canManage }: { canManage: boolean }) {
  const query = useAdminQuery(useCallback(() => adminApi.hours(), []), 'opening-hours');

  // A local copy so a half-finished edit is not fighting a poll, and so
  // "Save" is a deliberate act rather than seven separate writes.
  const [draft, setDraft] = useState<DayHours[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The hours gate the door, so a save is confirmed with the days that move.
  const [confirming, setConfirming] = useState(false);

  const rows = draft ?? query.data ?? [];
  const dirty = draft !== null;

  const edit = (dayOfWeek: number, patch: Partial<DayHours>): void => {
    setDraft((current) =>
      (current ?? query.data ?? []).map((day) =>
        day.dayOfWeek === dayOfWeek ? { ...day, ...patch } : day,
      ),
    );
  };

  /** Validates the draft, then asks. The write happens in `save`. */
  const ask = (): void => {
    if (draft === null) return;

    // Mirrors `GymHours_ordered`. Caught here so the counter sees which day
    // is wrong rather than a constraint violation naming none of them.
    const broken = draft.find((day) => !day.isClosed && day.closesAt <= day.opensAt);
    if (broken !== undefined) {
      setError(`${DAYS[broken.dayOfWeek]} closes before it opens.`);
      return;
    }

    setError(null);
    setConfirming(true);
  };

  const save = async (): Promise<void> => {
    if (draft === null) return;

    setBusy(true);
    setError(null);
    try {
      await adminApi.replaceHours(draft);
      setDraft(null);
      setConfirming(false);
      query.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card padded={false}>
      <div style={{ padding: '18px 18px 0' }}>
        <CardHead
          title="Opening hours"
          action={
            canManage && dirty ? (
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Discard
                </button>
                <button
                  type="button"
                  className="p-btn p-btn-gold p-btn-sm"
                  onClick={ask}
                  disabled={busy}
                >
                  Save hours
                </button>
              </div>
            ) : undefined
          }
        />
      </div>

      <DataState
        loading={query.loading}
        error={query.error}
        empty={rows.length === 0}
        emptyTitle="No hours configured"
        emptyHint="The gate falls back to GYM_OPEN_TIME and GYM_CLOSE_TIME."
        onRetry={query.reload}
      >
        <div className="a-scroll">
          <table className="p-table">
            <thead>
              <tr>
                <th>Day</th>
                <th>Opens</th>
                <th>Closes</th>
                <th>Closed all day</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((day) => (
                <tr key={day.dayOfWeek}>
                  <td>
                    {DAYS[day.dayOfWeek]}
                    {/* The pickers below are native <input type="time">, whose
                        clock format follows the BROWSER's locale and cannot be
                        set from CSS or a prop. This readout is the guarantee:
                        whatever the widget shows, the row states the hours in
                        plain 12-hour time. */}
                    <div className="a-person-sub">
                      {day.isClosed
                        ? 'Closed all day'
                        : `${hhmmTo12h(day.opensAt)} – ${hhmmTo12h(day.closesAt)}`}
                    </div>
                  </td>
                  <td>
                    <input
                      type="time"
                      className="a-input"
                      value={day.opensAt}
                      disabled={!canManage || day.isClosed || busy}
                      onChange={(event) => edit(day.dayOfWeek, { opensAt: event.target.value })}
                      style={{ width: 120 }}
                      aria-label={`${DAYS[day.dayOfWeek]} opening time`}
                    />
                  </td>
                  <td>
                    <input
                      type="time"
                      className="a-input"
                      value={day.closesAt}
                      disabled={!canManage || day.isClosed || busy}
                      onChange={(event) => edit(day.dayOfWeek, { closesAt: event.target.value })}
                      style={{ width: 120 }}
                      aria-label={`${DAYS[day.dayOfWeek]} closing time`}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={day.isClosed}
                      disabled={!canManage || busy}
                      onChange={(event) => edit(day.dayOfWeek, { isClosed: event.target.checked })}
                      style={{ width: 15, height: 15, accentColor: 'var(--gold)' }}
                      aria-label={`${DAYS[day.dayOfWeek]} closed all day`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DataState>

      {error !== null && (
        <div style={{ padding: '0 18px' }}>
          <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: '10px 0 0' }}>
            {error}
          </p>
        </div>
      )}

      <div style={{ padding: '14px 18px 18px' }}>
        <p className="p-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: 0 }}>
          These decide who gets through the door — a scan outside them is denied as{' '}
          <strong>GYM_CLOSED</strong>, with fifteen minutes of slack either side so staff arriving
          early and the last member leaving are not incidents. The website quotes the same hours.
          {canManage
            ? ''
            : ' Your account can view these but not change them.'}
        </p>
      </div>

      <ConfirmDialog
        open={confirming && draft !== null}
        title="Save the new opening hours?"
        consequence="Takes effect at the door immediately — a scan outside these hours is denied, and the website quotes them straight away."
        confirmLabel="Save hours"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void save()}
        onClose={() => {
          if (busy) return;
          setConfirming(false);
          setError(null);
        }}
      >
        <ul className="a-confirm-facts">
          {(draft === null ? [] : hoursChanges(query.data ?? [], draft)).map((line) => (
            <li key={line}>{line}</li>
          ))}
          {draft !== null && hoursChanges(query.data ?? [], draft).length === 0 ? (
            <li>No day actually changes — saving rewrites the same hours.</li>
          ) : null}
        </ul>
      </ConfirmDialog>
    </Card>
  );
}
