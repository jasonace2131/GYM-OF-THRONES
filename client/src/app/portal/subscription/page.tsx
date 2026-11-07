'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MembershipStatus, PERMISSIONS, PaymentStatus } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import {
  formatCentavos,
  formatCivilDate,
  getSubscription,
  type SubscriptionView,
} from '@/lib/portalData';
import { ApiError } from '@/lib/api';
import { accessLine, membershipStatusView, payHrefFor } from '@/lib/dashboard/membershipStatus';
import { RenewPlanDialog } from '@/components/portal/RenewPlanDialog';
import { Badge, Card, CardHead, EmptyState, ProgressRing, Skeleton } from '@/components/portal/ui';
import type { BadgeTone } from '@/components/portal/ui';

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
  const router = useRouter();
  const [data, setData] = useState<SubscriptionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);

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
  const status = membershipStatusView(membership, verdict);
  const memberLine = status.line;
  const dateLine = accessLine(membership, verdict);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <RenewPlanDialog
        open={renewing}
        plan={
          membership === null
            ? null
            : {
                name: membership.planName,
                priceCentavos: membership.planPriceCentavos,
                termMonths: membership.termMonths,
              }
        }
        onPay={() => router.push(payHrefFor(membership?.planCode ?? null))}
        onClose={() => setRenewing(false)}
      />
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

            {dateLine !== null && (
              // Keeps the gap under the price when there is no line above it.
              <p className="p-muted" style={{ marginTop: memberLine === null ? 10 : 4 }}>
                {dateLine}
              </p>
            )}

            {verdict.offer === 'RENEW' && (
              // This had no action at all: a member with a cancelled or
              // expired plan tapped it and nothing happened (owner bug report,
              // 2026-11-07). It now asks first, then opens Pay / GCash.
              <button
                type="button"
                className="p-btn p-btn-gold"
                style={{ marginTop: 18, padding: '13px 28px' }}
                onClick={() => setRenewing(true)}
              >
                {membership ? 'Renew' : 'Choose a plan'}
              </button>
            )}
          </div>

          {/* The dashboard's own ring rule, so the two screens agree: none for
              a plan that is cancelled, expired, paused or on its last day. */}
          {status.ring !== null && (
            <div style={{ marginInline: 'auto', flex: 'none' }}>
              <ProgressRing remaining={status.ring.remaining} total={status.ring.total} size={128} />
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
