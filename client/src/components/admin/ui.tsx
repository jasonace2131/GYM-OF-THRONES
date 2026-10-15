'use client';

import { useState, type ReactNode } from 'react';
import { Badge, Card, type BadgeTone } from '@/components/portal/ui';

/**
 * CRM building blocks. Everything here composes the portal's own primitives —
 * `Card`, `Badge`, `.p-table` — rather than reimplementing them.
 */

export function Kpi({
  value,
  label,
  delta,
  tone,
}: {
  value: ReactNode;
  label: string;
  delta?: string;
  tone?: 'ok' | 'warn' | 'danger';
}) {
  return (
    <Card hover>
      <div
        className="p-stat-val"
        style={
          tone === 'danger'
            ? { color: 'var(--p-danger)' }
            : tone === 'warn'
              ? { color: 'var(--p-warn)' }
              : undefined
        }
      >
        {value}
      </div>
      <div className="p-stat-label">{label}</div>
      {delta === undefined ? null : (
        <div className="a-kpi-delta" data-tone={tone}>
          {delta}
        </div>
      )}
    </Card>
  );
}

/**
 * A person cell: photo (or initials), name, and one quiet second line.
 *
 * The photo is here because recognising a face is what the desk actually does
 * with this column — it is the same reason `avatarUrl` earns its place on the
 * lobby feed.
 */
export function Person({
  firstName,
  lastName,
  sub,
  avatarUrl,
}: {
  firstName: string;
  lastName: string;
  sub?: string | null;
  avatarUrl?: string | null;
}) {
  const initials = `${firstName[0] ?? ''}${lastName[0] ?? ''}`.toUpperCase();
  /**
   * Set when the image fails, which drops us back to initials.
   *
   * Keyed on the URL so a re-render with a DIFFERENT member's avatar clears a
   * previous failure rather than inheriting it — without that, one broken
   * photo would blank every avatar rendered into the same slot after it.
   */
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const usable = avatarUrl != null && avatarUrl !== brokenUrl;

  return (
    <div className="a-person">
      {!usable ? (
        <span className="a-avatar" aria-hidden>
          {initials}
        </span>
      ) : (
        /*
         * ─────────────────────────────────────────────────────────────────
         * A PLAIN <img>, AND IT MUST STAY ONE.
         *
         * This was `next/image`, and it took the whole screen down. `avatarUrl`
         * is a free-text column, so its host is untrusted input — and
         * `next/image` THROWS a runtime error on a host absent from
         * `next.config.ts`, which configures no `remotePatterns` at all. One
         * member with an avatar on any external host turned the Members page
         * into a full-page error overlay, not a broken thumbnail.
         *
         * An avatar is decoration. It must never be able to stop a member of
         * staff finding somebody, so every way it can fail — unconfigured
         * host, 404, an expired signed URL — falls back to initials through
         * one `onError`.
         * ─────────────────────────────────────────────────────────────────
         */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          className="a-avatar"
          src={avatarUrl}
          alt=""
          aria-hidden
          width={32}
          height={32}
          onError={() => setBrokenUrl(avatarUrl)}
        />
      )}
      <span style={{ minWidth: 0 }}>
        <span className="a-person-name">
          {firstName} {lastName}
        </span>
        {sub == null ? null : <span className="a-person-sub">{sub}</span>}
      </span>
    </div>
  );
}

/**
 * THE STANDING BADGE, and the one rule it follows.
 *
 * It renders the DOOR's decision, never the stored status column. Every list
 * in this CRM projects the stored value through `accessVerdict` server-side
 * for exactly this reason: a missed nightly run leaves rows reading ACTIVE
 * that the door correctly refuses, and a CRM showing the stale value is how a
 * staffer tells a member they are fine while the counter says otherwise.
 */
export function StandingBadge({
  decision,
  daysRemaining,
  hasMembership,
}: {
  decision: 'ALLOW' | 'GRACE' | 'DENY';
  daysRemaining: number | null;
  hasMembership: boolean;
}) {
  if (!hasMembership) return <Badge tone="neutral">No plan</Badge>;
  if (decision === 'GRACE') return <Badge tone="warn">In grace</Badge>;
  if (decision === 'DENY') return <Badge tone="danger">Expired</Badge>;
  if (daysRemaining !== null && daysRemaining <= 7) return <Badge tone="warn">Expiring</Badge>;
  return <Badge tone="ok">Active</Badge>;
}

/**
 * Days left as a bar plus a number.
 *
 * The tone escalates as expiry approaches, which is the point: a flat "14d"
 * reads identically at 14 days and at 1, and 1 is exactly when it should be
 * shouting.
 */
export function DaysLeft({ days, termDays = 30 }: { days: number | null; termDays?: number }) {
  if (days === null) return <span className="p-muted">—</span>;

  const clamped = Math.max(0, Math.min(days, termDays));
  const tone = days <= 3 ? 'danger' : days <= 7 ? 'warn' : undefined;

  return (
    <span className="a-days">
      <span className="a-days-track">
        <span
          className="a-days-fill"
          data-tone={tone}
          style={{ width: `${(clamped / termDays) * 100}%` }}
        />
      </span>
      <span className="p-num" style={{ fontSize: 12, minWidth: 30 }}>
        {days}d
      </span>
    </span>
  );
}

export function Pager({
  page,
  limit,
  total,
  onPage,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);

  return (
    <div className="a-pager">
      <span>
        Showing {from}–{to} of {total}
      </span>
      <span className="a-pager-controls">
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          ← Prev
        </button>
        <span style={{ padding: '0 8px' }}>
          {page} / {pages}
        </span>
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
        >
          Next →
        </button>
      </span>
    </div>
  );
}

/**
 * The three states every data screen has, in one place.
 *
 * An error is rendered as a RETRYABLE message, never as an empty table: an
 * empty table says "you have no members", which is a different and much more
 * alarming statement than "we could not reach the server".
 */
export function DataState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyHint,
  onRetry,
  inset = false,
  children,
}: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle: string;
  emptyHint?: string;
  onRetry: () => void;
  /**
   * Draw the states flush inside a card the caller already rendered, instead
   * of as a Card of their own — which inside another card is a box in a box.
   */
  inset?: boolean;
  children: ReactNode;
}) {
  if (inset) {
    if (error !== null) {
      return (
        <div className="a-inset-state" role="alert">
          <strong>Could not load this</strong>
          <span>{error}</span>
          <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      );
    }
    if (loading) {
      return (
        <div className="a-inset-state" aria-busy="true">
          <span>Loading…</span>
        </div>
      );
    }
    if (empty) {
      return (
        <div className="a-inset-state">
          <strong>{emptyTitle}</strong>
          {emptyHint === undefined ? null : <span>{emptyHint}</span>}
        </div>
      );
    }
    return <>{children}</>;
  }

  if (error !== null) {
    return (
      <Card>
        <div style={{ display: 'grid', gap: 10, justifyItems: 'start' }}>
          <strong>Could not load this</strong>
          <span className="p-muted">{error}</span>
          <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      </Card>
    );
  }

  if (loading) {
    return (
      <Card>
        <span className="p-muted">Loading…</span>
      </Card>
    );
  }

  if (empty) {
    return (
      <Card>
        <div style={{ display: 'grid', gap: 6 }}>
          <strong>{emptyTitle}</strong>
          {emptyHint === undefined ? null : <span className="p-muted">{emptyHint}</span>}
        </div>
      </Card>
    );
  }

  return <>{children}</>;
}

export function toneForDecision(decision: 'ALLOW' | 'GRACE' | 'DENY'): BadgeTone {
  return decision === 'ALLOW' ? 'ok' : decision === 'GRACE' ? 'warn' : 'danger';
}
