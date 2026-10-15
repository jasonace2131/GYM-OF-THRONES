'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { formatCentavos, formatCivilDate, getPayData, type PayData } from '@/lib/portalData';
import { hhmmTo12h } from '@/lib/gymTime';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { GcashClaimCard } from '@/components/portal/GcashClaimCard';

/**
 * How to pay, and what you have paid. Nothing else.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS SCREEN CANNOT TAKE MONEY, AND THAT IS THE DESIGN (decision #9).
 *
 * Payments are staff-recorded only. Every peso lands in a counted till against
 * an open shift, entered by a person who saw it. A portal that could POST a
 * purchase would create money the drawer never saw, and the first blind close
 * that came up ₱800 short would have no explanation.
 *
 * What this replaced: a GCash screenshot-upload flow that posted to nothing and
 * hardcoded `0917 123 4567` as the gym's number — a fake number on a payment
 * screen, which is how a member's money reaches a stranger.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger'> = {
  RECORDED: 'ok',
  VOIDED: 'danger',
};

/** A member's own section: `membership.self` — see the subscription page. */
export default function PayPage() {
  return (
    <RequirePermission permission={PERMISSIONS.MEMBERSHIP_SELF}>
      <Pay />
    </RequirePermission>
  );
}

function Pay() {
  const [data, setData] = useState<PayData | null>(null);
  const [failed, setFailed] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void getPayData()
      .then(setData)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <EmptyState
        title="Could not load payment details"
        hint="Check your connection and refresh. Your payment history is safe."
      />
    );
  }

  if (!data) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={200} />
        <Skeleton height={220} />
        <Skeleton height={280} />
      </div>
    );
  }

  const gcashNumber = data.gcashNumber;

  const copyNumber = async (): Promise<void> => {
    if (gcashNumber === null) return;
    try {
      await navigator.clipboard.writeText(gcashNumber.replace(/\s/g, ''));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is unavailable on a non-secure origin and inside some in-app
      // browsers. The number is on screen either way, so this is a convenience
      // failing rather than the feature failing.
      setCopied(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card>
        <CardHead title="How to pay" />
        <div style={{ display: 'grid', gap: 16, paddingTop: 4 }}>
          <section>
            <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>At the front desk</h3>
            <p style={{ margin: 0, color: 'var(--p-ink2)', fontSize: 14, lineHeight: 1.55 }}>
              Cash or GCash, any time we are open — {hhmmTo12h(data.openTime)} to{' '}
              {hhmmTo12h(data.closeTime)}. Staff record it while you are there and your access
              updates immediately.
            </p>
          </section>

          <section>
            <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>GCash</h3>
            {gcashNumber === null ? (
              // No placeholder number, ever. A plausible-looking wrong GCash
              // number sends a member's money to a stranger, and unlike a
              // missing section that is not recoverable.
              <p style={{ margin: 0, color: 'var(--p-ink2)', fontSize: 14, lineHeight: 1.55 }}>
                Ask at the front desk for the gym&rsquo;s GCash details.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 22,
                      fontWeight: 700,
                      letterSpacing: '0.02em',
                    }}
                  >
                    {gcashNumber}
                  </span>
                  <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={copyNumber}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                {data.gcashName === null ? null : (
                  <p style={{ margin: '4px 0 0', color: 'var(--p-ink3)', fontSize: 13 }}>
                    Registered to {data.gcashName}
                  </p>
                )}
                <p
                  style={{
                    margin: '10px 0 0',
                    color: 'var(--p-ink2)',
                    fontSize: 14,
                    lineHeight: 1.55,
                  }}
                >
                  {/* The reference is what reconciles the row against the
                      monthly statement. Without it the payment cannot be
                      matched to anything. */}
                  Send the amount, then <strong>send us the reference number below</strong> — or
                  show it at the desk. Either way your payment is not active until staff have
                  confirmed it against the gym&rsquo;s own GCash account.
                </p>
              </>
            )}
          </section>
        </div>
      </Card>

      {/* The member's half of a GCash payment, and the reason the copy above
          no longer sends them to the counter to read a number aloud. It takes
          a claim; it does not take money. See GcashClaimCard's own header. */}
      <GcashClaimCard
        plans={data.plans.map((plan) => ({
          code: plan.code,
          name: plan.name,
          priceCentavos: plan.priceCentavos,
        }))}
      />

      <Card padded={false}>
        <CardHead title="Prices" />
        {/* An empty price list rendered as a bare header row with nothing under
            it reads as a broken screen, and it is exactly what a member sees
            before any plan is on sale. The sibling card below already had an
            empty state; this one did not. */}
        {data.plans.length === 0 ? (
          <EmptyState
            title="No plans on sale yet"
            hint="Prices appear here once the gym publishes them. The front desk can still take a payment."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="p-table" data-stack>
              <thead>
                <tr>
                  <th>Plan</th>
                  <th>Price</th>
                  <th>Term</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.plans.map((plan) => (
                  <tr key={plan.code}>
                    <td>
                      <strong>{plan.name}</strong>
                      {plan.description === null ? null : (
                        <div style={{ color: 'var(--p-ink3)', fontSize: 12.5, marginTop: 2 }}>
                          {plan.description}
                        </div>
                      )}
                    </td>
                    <td data-label="Price">{formatCentavos(plan.priceCentavos)}</td>
                    <td data-label="Term">
                      {plan.termMonths === null
                        ? 'One day'
                        : `${plan.termMonths} month${plan.termMonths === 1 ? '' : 's'}`}
                    </td>
                    <td>
                      {plan.code === data.currentPlanCode ? (
                        <Badge tone="ok">Your plan</Badge>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p
          className="p-card-pad"
          style={{ margin: 0, color: 'var(--p-ink3)', fontSize: 13, lineHeight: 1.5 }}
        >
          {/* RA 9994 / RA 10754 make this mandatory for workout gyms, and the
              computation depends on whether the gym is VAT-registered — which
              is why it is quoted at the counter, not calculated here. */}
          Senior citizen and PWD discounts are applied at the counter on presentation of your OSCA
          or PWD ID.
        </p>
      </Card>

      <Card padded={false}>
        <CardHead title="Your payments" />
        {data.payments.length === 0 ? (
          <EmptyState
            title="No payments yet"
            hint="Anything you pay at the desk appears here once staff record it."
          />
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="p-table" data-stack>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>Method</th>
                  <th>Reference</th>
                  <th>Receipt</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((payment) => (
                  <tr key={payment.id}>
                    <td data-label="Date">{formatCivilDate(payment.businessDate)}</td>
                    <td data-label="Amount">{formatCentavos(payment.netCentavos)}</td>
                    <td data-label="Method">{payment.method === 'GCASH' ? 'GCash' : 'Cash'}</td>
                    <td data-label="Reference" style={{ color: 'var(--p-ink3)' }}>
                      {payment.reference ?? '—'}
                    </td>
                    <td data-label="Receipt" style={{ color: 'var(--p-ink3)' }}>
                      {payment.receiptNo ?? '—'}
                    </td>
                    <td data-label="Status">
                      <Badge tone={STATUS_TONE[payment.status] ?? 'warn'}>
                        {payment.status === 'RECORDED' ? 'Paid' : 'Voided'}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
