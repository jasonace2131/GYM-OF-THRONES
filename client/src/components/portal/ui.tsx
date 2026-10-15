'use client';

import type { CSSProperties, ReactNode, Ref } from 'react';

/* ── Card ──────────────────────────────────────────────── */

export function Card({
  children,
  padded = true,
  hover = false,
  style,
}: {
  children: ReactNode;
  padded?: boolean;
  hover?: boolean;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`p-card${padded ? ' p-card-pad' : ''}${hover ? ' p-card-hover' : ''}`}
      style={style}
    >
      {children}
    </div>
  );
}

/**
 * A card's header row.
 *
 * `as="h2"` makes the title a real heading, so a screen reader's heading list
 * reads the dashboard's sections. The default stays `span` because most cards
 * sit under a page whose own heading structure does not expect one.
 */
export function CardHead({
  title,
  action,
  as: Title = 'span',
  id,
  headingRef,
}: {
  title: ReactNode;
  action?: ReactNode;
  as?: 'span' | 'h2';
  id?: string;
  /** Makes the title a programmatic focus target (tabIndex -1), for deep links. */
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="p-card-head">
      <Title
        className="p-card-title"
        id={id}
        ref={headingRef}
        tabIndex={headingRef === undefined ? undefined : -1}
      >
        {title}
      </Title>
      {action}
    </div>
  );
}

/* ── Badge ─────────────────────────────────────────────── */

export type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`p-badge p-badge-${tone}`}>{children}</span>;
}

/* ── Stat ──────────────────────────────────────────────── */

export function Stat({
  value,
  label,
  accent = false,
}: {
  value: ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <Card hover>
      <div className="p-stat-val" style={accent ? { color: 'var(--gold-dark)' } : undefined}>
        {value}
      </div>
      <div className="p-stat-label">{label}</div>
    </Card>
  );
}

/* ── Progress ring ─────────────────────────────────────── */

/**
 * Days-remaining ring.
 *
 * The tone escalates as expiry approaches, which is the whole point: a flat
 * "14 days left" tile reads identically at 14 days and at 1, and 1 is exactly
 * when it should be shouting.
 *
 * Pass `tone` whenever the caller has the server's verdict: "expiring soon" is
 * decided by `accessVerdict()` (allowReason), and the fallback thresholds
 * below are only for a caller that has no verdict to key on.
 */
export type RingTone = 'ok' | 'warn' | 'danger' | 'neutral';

const RING_TONE: Record<RingTone, string> = {
  ok: 'var(--p-ok)',
  // Not --gold: the numeral is drawn in this colour too, and gold on white is
  // about 2.6:1. The warn ink clears 4.5:1 at any size.
  warn: 'var(--p-warn)',
  danger: 'var(--p-danger)',
  neutral: 'var(--p-ink3)',
};

export function ProgressRing({
  remaining,
  total,
  size = 108,
  tone: toneKey,
}: {
  remaining: number;
  total: number;
  size?: number;
  tone?: RingTone;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, remaining / Math.max(total, 1)));

  const tone =
    toneKey !== undefined
      ? RING_TONE[toneKey]
      : remaining <= 3
        ? 'var(--p-danger)'
        : remaining <= 7
          ? 'var(--gold)'
          : 'var(--p-ok)';

  return (
    <div style={{ position: 'relative', width: size, height: size, flex: 'none' }}>
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
          strokeDashoffset={circumference * (1 - pct)}
          style={{ transition: 'stroke-dashoffset .7s cubic-bezier(.22,.7,.2,1)' }}
        />
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          textAlign: 'center',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: size * 0.28,
              lineHeight: 1,
              color: tone,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {remaining}
          </div>
          <div
            style={{
              fontSize: 9.5,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--p-ink3)',
              marginTop: 3,
            }}
          >
            days left
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── Empty / loading ───────────────────────────────────── */

/**
 * An empty or failed state. `action` is the way out — every empty state in
 * the portal should offer one (a link to fill the gap, or "Try again").
 */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div style={{ padding: '38px 22px', textAlign: 'center' }}>
      <div
        style={{
          fontFamily: 'var(--font-heading)',
          fontWeight: 600,
          fontSize: 14.5,
          color: 'var(--p-ink2)',
        }}
      >
        {title}
      </div>
      {hint && (
        <div className="p-muted" style={{ marginTop: 6, fontSize: 13 }}>
          {hint}
        </div>
      )}
      {action ? <div style={{ marginTop: 16 }}>{action}</div> : null}
    </div>
  );
}

export function Skeleton({ height = 100 }: { height?: number }) {
  return (
    <div
      aria-hidden
      style={{
        height,
        borderRadius: 'var(--p-radius)',
        background: 'linear-gradient(100deg, #efedea 30%, #f7f6f4 50%, #efedea 70%)',
        backgroundSize: '200% 100%',
        animation: 'pShimmer 1.3s linear infinite',
      }}
    />
  );
}
