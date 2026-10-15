'use client';

import type { ReactNode } from 'react';
import { formatCivilDate } from '@/lib/gymTime';
import {
  historyLatestFirst,
  measurementSummary,
  provenanceLabel,
} from '@/lib/progress/progressView';
import type { Measurement } from '@/lib/progress/types';

/**
 * Every recorded day, newest first, each with who recorded it.
 *
 * `actions` renders per-row controls (the coach's Edit/Delete); the member's
 * page passes none. `expanded` swaps a row's body for something else — the
 * coach's inline edit form — without the list having to know what it is.
 *
 * Legacy markup only: this folder is not Tailwind-scanned.
 */
export function MeasurementHistory({
  entries,
  actions,
  expanded,
  showProvenance = true,
}: {
  entries: readonly Measurement[];
  actions?: (entry: Measurement) => ReactNode;
  expanded?: (entry: Measurement) => ReactNode | null;
  /** False on a server that sent no provenance — see `pageMode`. */
  showProvenance?: boolean;
}) {
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid' }}>
      {historyLatestFirst(entries).map((entry, index) => {
        const provenance = showProvenance ? provenanceLabel(entry) : null;
        const open = expanded?.(entry) ?? null;

        return (
          <li
            key={entry.id}
            style={{
              padding: '12px 0',
              borderTop: index === 0 ? 'none' : '1px solid var(--p-border)',
              display: 'grid',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                <div style={{ fontSize: 12, color: 'var(--p-ink3)', fontWeight: 600 }}>
                  {formatCivilDate(entry.businessDate)}
                </div>
                <div
                  style={{ fontSize: 14.5, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                >
                  {measurementSummary(entry)}
                </div>
                {entry.notes === null ? null : (
                  <div style={{ fontSize: 13, color: 'var(--p-ink2)', marginTop: 2 }}>
                    {entry.notes}
                  </div>
                )}
                {provenance === null ? null : (
                  <div style={{ fontSize: 11.5, color: 'var(--p-ink3)', marginTop: 3 }}>
                    {provenance}
                  </div>
                )}
              </div>
              {actions === undefined || open !== null ? null : (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {actions(entry)}
                </div>
              )}
            </div>
            {open}
          </li>
        );
      })}
    </ul>
  );
}
