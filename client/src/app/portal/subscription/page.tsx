'use client';

import { useEffect, useState } from 'react';
import { MembershipStatus, PERMISSIONS, PaymentStatus } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import {
  formatCentavos,
  formatCivilDate,
  getSubscription,
  type SubscriptionView,
} from '@/lib/portalData';
import { ApiError } from '@/lib/api';
import { membershipStatusView } from '@/lib/dashboard/membershipStatus';
import { Badge, Card, CardHead, EmptyState, ProgressRing, Skeleton } from '@/components/portal/ui';
import type { BadgeTone } from '@/components/portal/ui';
import { IconArrow } from '@/components/portal/icons';

/**
 * The four-value vocabulary, verbatim. There is no "expiring" status: grace is a
 * date, and how worried to be is the server's AccessResult, not a date the
 * browser re-derives (spec 3.3 rule 1).
 */
const STATUS_LABEL: Record<MembershipStatus, string> = {
  [MembershipStatus.ACTIVE]: 'Active',
  [MembershipStatus.EXPIRED]: 'Expired',
  [MembershipStatus.FROZEN]: 'Frozen',
  [MembershipStatus.CANCELLED]: 'Cancelled',
};

const DECISION_TONE: Record<string, BadgeTone> = {
  ALLOW: 'ok',
  GRACE: 'warn',
  DENY: 'danger',
};

const PAYMENT_TONE: Record<PaymentStatus, BadgeTone> = {
  [PaymentStatus.RECORDED]: 'ok',
  [PaymentStatus.VOIDED]: 'danger',
};

/**
 * A member's own section: `membership.self`, which only CLIENT holds. Coaches,
 * the desk and admins are not members here (owner decision, 2026-09-25), so
 * opened by URL they get "not available for your role" instead of an empty
 * plan card.
 */
export default function SubscriptionPage() {
  return (
    <RequirePermission permission={PERMISSIONS.MEMBERSHIP_SELF}>
      <Subscription />
    </RequirePermission>
  );
}

function Subscription() {
  const [data, setData] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSubscription()
      .then(setData)
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiError
            ? cause.message
            : 'We could not load your membership. Try again in a moment.',
        );
      });
  }, []);

  if (error) {
    return <EmptyState title="Membership unavailable" hint={error} />;
  }

  if (!data) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={200} />
        <Skeleton height={260} />
      </div>
    );
  }

  const { membership, verdict, plans, payments } = data;
  const tone = DECISION_TONE[verdict.decision] ?? 'neutral';
  /**
   * NEVER `verdict.message`. That sentence is the desk's ("… Let them in.",
   * "Sell a walk-in …") and was shown here to the member verbatim. This is
   * the member's own copy, keyed on the server's reason: the same line the
   * dashboard's status band shows, so the two screens cannot disagree. Null
   * for a plan in good standing, where the "Access runs to" line below says
   * it all.
   */
  const memberLine = membershipStatusView(membership, verdict).line;

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, alignItems: 'center' }}>
          <div style={{ flex: '1 1 300px', minWidth: 0 }}>
            <div className="p-card-title">Current plan</div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginTop: 10 }}>
              <span className="p-h1">{membership?.planName ?? 'No plan'}</span>
              {membership && <Badge tone={tone}>{STATUS_LABEL[membership.status]}</Badge>}
            </div>

            {membership && (
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 800,
                    fontSize: 30,
                    color: 'var(--p-ink)',
                  }}
                >
                  {formatCentavos(membership.planPriceCentavos)}
                </span>
                <span className="p-muted">
                  per {membership.termMonths === 1 ? 'month' : `${membership.termMonths} months`}
                </span>
              </div>
            )}

            {memberLine !== null && (
              <p className="p-muted" style={{ marginTop: 10 }}>
                {memberLine}
              </p>
            )}

            {membership && (
              // Keeps the gap under the price when there is no line above it.
              <p className="p-muted" style={{ marginTop: memberLine === null ? 10 : 4 }}>
                Access runs to {formatCivilDate(membership.endsOn)}
                {membership.cancelRequestedOn
                  ? ` — cancelling, notice given ${formatCivilDate(membership.cancelRequestedOn)}.`
                  : '.'}
              </p>
            )}

            {verdict.offer === 'RENEW' && (
              <button
                type="button"
                className="p-btn p-btn-gold"
                style={{ marginTop: 18, padding: '13px 28px' }}
              >
                Renew at the front desk
                <IconArrow />
              </button>
            )}
          </div>

          {membership && verdict.daysRemaining !== null && (
            <div style={{ marginInline: 'auto', flex: 'none' }}>
              <ProgressRing
                remaining={verdict.daysRemaining}
                total={membership.termMonths * 30}
                size={128}
              />
            </div>
          )}
        </div>
      </Card>

      <div>
        <h2 className="p-h2" style={{ marginBottom: 4 }}>
          Plans
        </h2>
        <p className="p-muted" style={{ marginBottom: 16 }}>
          Longer terms cost less per month. Ask the front desk to switch — it takes effect at your
          next renewal.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))',
            gap: 14,
          }}
        >
          {plans.map((plan) => {
            const current = plan.code === membership?.planCode;
            return (
              <Card
                key={plan.code}
                hover={!current}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                  borderColor: current ? 'var(--gold)' : undefined,
                  boxShadow: current ? '0 0 0 1px var(--gold), var(--p-shadow)' : undefined,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 24 }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--p-ink3)',
                    }}
                  >
                    {plan.name}
                  </span>
                  {current && <Badge tone="warn">Current</Badge>}
                </div>

                <div
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 800,
                    fontSize: 32,
                    lineHeight: 1,
                    letterSpacing: '-0.02em',
                    color: 'var(--p-ink)',
                  }}
                >
                  {formatCentavos(plan.priceCentavos)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--gold-dark)', minHeight: 18 }}>
                  {plan.termMonths ? `${plan.termMonths}-month term` : 'Single visit'}
                </div>
              </Card>
            );
          })}
        </div>
      </div>

      <Card padded={false}>
        <CardHead title="Payment history" />
        <div style={{ overflowX: 'auto' }}>
          <table className="p-table" data-stack>
            <thead>
              <tr>
                <th>Date</th>
                <th>Amount</th>
                <th>Method</th>
                <th>Reference</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td data-label="Date" style={{ whiteSpace: 'nowrap', color: 'var(--p-ink)' }}>
                    {formatCivilDate(payment.businessDate)}
                  </td>
                  <td
                    data-label="Amount"
                    className="p-num"
                    style={{ fontWeight: 600, color: 'var(--p-ink)' }}
                  >
                    {formatCentavos(payment.netCentavos)}
                  </td>
                  <td data-label="Method">{payment.method === 'GCASH' ? 'GCash' : 'Cash'}</td>
                  <td
                    data-label="Reference"
                    className="p-num"
                    style={{ fontSize: 12.5, color: 'var(--p-ink3)' }}
                  >
                    {payment.reference ?? payment.receiptNo ?? '—'}
                  </td>
                  <td data-label="Status">
                    <Badge tone={PAYMENT_TONE[payment.status]}>
                      {payment.status === PaymentStatus.RECORDED ? 'paid' : 'voided'}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
