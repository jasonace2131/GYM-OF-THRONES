'use client';

import { useCallback } from 'react';
import { adminApi, gymTime } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';

/**
 * Drawer state, in the topbar of every admin page.
 *
 * It lives in the shell rather than on the dashboard because the failure it
 * prevents is "the drawer was left open overnight", and that does not happen
 * to somebody looking at the dashboard — it happens to somebody who spent the
 * evening on Members and went home. A state you can only see on one screen is
 * a state nobody checks.
 *
 * Renders NOTHING without `shift.manage`, and nothing while it is still
 * loading. A pill that flickers "closed" into "open" on every navigation is
 * worse than one that appears a beat late.
 */
export function ShiftPill({ canManage }: { canManage: boolean }) {
  const shift = useAdminQuery(
    useCallback(() => (canManage ? adminApi.currentShift() : Promise.resolve(null)), [canManage]),
    `shift-pill:${canManage}`,
    // Slower than the dashboard's own copy: this one is an ambient reminder,
    // not a control, and it is mounted on every page in the console.
    { pollMs: canManage ? 120_000 : undefined },
  );

  if (!canManage || shift.loading) return null;

  // The label is wrapped so the narrow-console rule in admin.css can drop it
  // and keep the status dot. It was a bare text node, which nothing can
  // target — and `white-space: nowrap` on the pill then pushed the topbar
  // past the viewport, where `overflow-x: hidden` clipped the avatar and the
  // surface switch out of reach rather than letting anyone scroll to them.
  if (shift.data === null) {
    return (
      <span className="a-shift" data-state="closed" title="Drawer closed">
        <i aria-hidden />
        <span>Drawer closed</span>
      </span>
    );
  }

  return (
    <span className="a-shift" data-state="open" title="Shift open">
      <i aria-hidden />
      <span>Shift open · {gymTime(shift.data.openedAt)}</span>
    </span>
  );
}
