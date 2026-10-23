'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  adminApi,
  peso,
  type DiscountTypeCode,
  type MembershipDetail,
  type PaymentMethodCode,
} from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { Modal, ModalError } from '../Modal';
import { GcashFields } from '../GcashFields';
import {
  DiscountAmountField,
  EMPTY_DISCOUNT,
  PriceSummary,
  useVatRegistered,
  type DiscountInput,
} from '../DiscountEntry';
import { parseDiscount, saleAmounts } from '@/lib/payments/discount';
import { ReceiptNoField } from '../ReceiptNoField';
import { ConfirmDialog } from './ConfirmDialog';
import { STATUTORY_ID_MAX } from '@got/shared';

/** Exported so `NewMemberDrawer`'s inline "sell a plan now" step (C6) uses the
 *  same vocabulary rather than a second hand-typed copy that could drift. */
export const DISCOUNTS: { value: DiscountTypeCode; label: string }[] = [
  { value: 'NONE', label: 'None' },
  { value: 'SENIOR', label: 'Senior (RA 9994)' },
  { value: 'PWD', label: 'PWD (RA 10754)' },
  { value: 'PROMO', label: 'Promo' },
  { value: 'STAFF', label: 'Staff' },
  { value: 'GUEST_PASS', label: 'Guest pass' },
  { value: 'GOODWILL', label: 'Goodwill' },
];

/** SENIOR/PWD are statutory — the server computes the arithmetic and ignores
 *  a centavo figure sent here. Only these four are discretionary, matching
 *  `Payment_discount_shape`'s own split. */
export const DISCRETIONARY: DiscountTypeCode[] = ['PROMO', 'STAFF', 'GUEST_PASS', 'GOODWILL'];

/**
 * Assign (sell) or replace (renew) a plan — one form, because
 * `CreateMembershipDto` and `RenewMembershipDto` are the same money shape
 * (renew just drops `userId`, which the path already carries).
 *
 * No `startsOn` field anywhere here, on purpose: §5.7.3's four renewal cases
 * are the server's decision from `gymToday()`, never the client's. No price
 * field either — `grossCentavos` is the plan's list price, resolved
 * server-side, so nothing here can quote a stale figure.
 */
export function SellMembershipModal({
  open,
  mode,
  userId,
  membershipId,
  memberName,
  onClose,
  onSold,
}: {
  open: boolean;
  mode: 'sell' | 'renew';
  userId: string;
  /** Required when `mode === 'renew'`. */
  membershipId?: string;
  memberName: string;
  onClose: () => void;
  onSold: (detail: MembershipDetail) => void;
}) {
  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'sell-plans');
  const plans = (plansQuery.data?.items ?? []).filter((p) => p.kind === 'TERM' && p.isActive);

  const [planCode, setPlanCode] = useState('');
  const [method, setMethod] = useState<PaymentMethodCode>('CASH');
  const [reference, setReference] = useState('');
  const [gcashVerified, setGcashVerified] = useState(false);
  const [receiptNo, setReceiptNo] = useState('');
  const [discountType, setDiscountType] = useState<DiscountTypeCode>('NONE');
  const [discount, setDiscount] = useState<DiscountInput>(EMPTY_DISCOUNT);
  const [statutoryIdNo, setStatutoryIdNo] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Money moves on confirm, so the form hands over to ConfirmDialog first.
  const [confirming, setConfirming] = useState(false);

  // The list loads async; default to the first plan once it lands.
  useEffect(() => {
    if (open && planCode === '' && plans.length > 0) setPlanCode(plans[0]!.code);
  }, [open, plans, planCode]);

  const reset = (): void => {
    setPlanCode('');
    setMethod('CASH');
    setReference('');
    setGcashVerified(false);
    setReceiptNo('');
    setDiscountType('NONE');
    setDiscount(EMPTY_DISCOUNT);
    setStatutoryIdNo('');
    setDiscountReason('');
    setError(null);
    setBusy(false);
    setConfirming(false);
  };

  const close = (): void => {
    if (busy) return;
    reset();
    onClose();
  };

  const selectedPlan = plans.find((plan) => plan.code === planCode) ?? null;
  const discountLabel = DISCOUNTS.find((option) => option.value === discountType)?.label ?? '';
  const discretionary = DISCRETIONARY.includes(discountType);
  const statutory = discountType === 'SENIOR' || discountType === 'PWD';
  const trimmedDiscountReason = discountReason.trim();

  // The total is derived, never typed: the shared arithmetic the server saves
  // with, run on what is on screen.
  const vatRegistered = useVatRegistered();
  const parsedDiscount = parseDiscount(
    discount.mode,
    discount.input,
    selectedPlan?.priceCentavos ?? 0,
  );
  const operatorDiscountCentavos =
    discretionary && parsedDiscount.kind === 'ok' ? parsedDiscount.centavos : 0;
  const amounts = saleAmounts({
    priceCentavos: selectedPlan?.priceCentavos ?? null,
    discountType,
    vatRegistered,
    operatorDiscountCentavos,
  });

  const valid =
    planCode !== '' &&
    (!discretionary ||
      (operatorDiscountCentavos > 0 &&
        trimmedDiscountReason.length >= 3 &&
        trimmedDiscountReason.length <= 200));

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        planCode,
        discountType: discountType === 'NONE' ? undefined : discountType,
        discountCentavos: discretionary ? operatorDiscountCentavos : undefined,
        statutoryIdNo: statutoryIdNo.trim() === '' ? undefined : statutoryIdNo.trim(),
        discountReason: discountReason.trim() === '' ? undefined : discountReason.trim(),
        method,
        reference: reference.trim() === '' ? undefined : reference.trim(),
        gcashVerified: method === 'GCASH' ? gcashVerified : undefined,
        receiptNo: receiptNo.trim() === '' ? undefined : receiptNo.trim(),
      };
      const detail =
        mode === 'sell'
          ? await adminApi.sellMembership({ userId, ...body })
          : await adminApi.renewMembership(membershipId!, body);
      onSold(detail);
      reset();
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title={mode === 'sell' ? 'Assign a plan' : 'Replace the plan'}
        subtitle={`For ${memberName}.`}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || !valid || plansQuery.loading}
            >
              {mode === 'sell' ? 'Assign plan' : 'Replace plan'}
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="sell-plan-code">
            Plan
          </label>
          <select
            id="sell-plan-code"
            className="a-select"
            style={{ width: '100%' }}
            value={planCode}
            disabled={plansQuery.loading || plans.length === 0}
            onChange={(event) => setPlanCode(event.target.value)}
          >
            {plans.length === 0 && <option value="">— no plans available —</option>}
            {plans.map((plan) => (
              <option key={plan.code} value={plan.code}>
                {plan.name} — {peso(plan.priceCentavos)}
                {plan.termMonths === null ? '' : ` / ${plan.termMonths}mo`}
              </option>
            ))}
          </select>
        </div>

        <div className="a-field">
          <span className="a-field-label">Method</span>
          <div className="a-seg" role="radiogroup" aria-label="Payment method">
            {(['CASH', 'GCASH'] as const).map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={method === option}
                className="a-seg-btn"
                data-on={method === option || undefined}
                onClick={() => setMethod(option)}
              >
                {option === 'CASH' ? 'Cash' : 'GCash'}
              </button>
            ))}
          </div>
        </div>

        <GcashFields
          method={method}
          reference={reference}
          onReference={setReference}
          verified={gcashVerified}
          onVerified={setGcashVerified}
        />

        <ReceiptNoField value={receiptNo} onChange={setReceiptNo} highlight={statutory} />

        <div className="a-field">
          <label className="a-field-label" htmlFor="sell-discount">
            Discount
          </label>
          <select
            id="sell-discount"
            className="a-select"
            style={{ width: '100%' }}
            value={discountType}
            onChange={(event) => setDiscountType(event.target.value as DiscountTypeCode)}
          >
            {DISCOUNTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {statutory && (
          <div className="a-field">
            <label className="a-field-label" htmlFor="sell-statutory-id">
              OSCA / PWD ID <span className="a-field-opt">optional — falls back to the profile</span>
            </label>
            <input
              id="sell-statutory-id"
              className="a-input"
              value={statutoryIdNo}
              maxLength={STATUTORY_ID_MAX}
              autoComplete="off"
              onChange={(event) => setStatutoryIdNo(event.target.value)}
            />
          </div>
        )}

        {discretionary && (
          <>
            <DiscountAmountField
              id="sell-discount-amount"
              value={discount}
              onChange={setDiscount}
              priceCentavos={selectedPlan?.priceCentavos ?? null}
              parsed={parsedDiscount}
            />

            <div className="a-field">
              <label className="a-field-label" htmlFor="sell-discount-reason">
                Discount reason
              </label>
              <input
                id="sell-discount-reason"
                className="a-input"
                value={discountReason}
                maxLength={200}
                autoComplete="off"
                placeholder="At least 3 characters"
                onChange={(event) => setDiscountReason(event.target.value)}
              />
            </div>
          </>
        )}

        <PriceSummary
          itemName={selectedPlan?.name ?? null}
          amounts={amounts}
          discountType={discountType}
        />

        <ModalError message={error ?? plansQuery.error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={
          mode === 'sell'
            ? `Assign ${selectedPlan?.name ?? 'this plan'} to ${memberName}?`
            : `Replace ${memberName}'s plan with ${selectedPlan?.name ?? 'this plan'}?`
        }
        consequence={
          mode === 'sell'
            ? `Takes the payment by ${method === 'CASH' ? 'cash' : 'GCash'} and starts the membership. The server works out the start date.`
            : `Takes the payment by ${method === 'CASH' ? 'cash' : 'GCash'} and replaces the current term. The server works out when the new term starts.`
        }
        confirmLabel={mode === 'sell' ? 'Assign plan' : 'Replace plan'}
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>
            <strong>{selectedPlan === null ? planCode : selectedPlan.name}</strong>
            {selectedPlan === null ? '' : ` — list price ${peso(selectedPlan.priceCentavos)}`}
          </li>
          {discountType === 'NONE' ? null : (
            <li>
              Discount: {discountLabel}
              {amounts === null || amounts.discountCentavos === 0
                ? ''
                : ` — less ${peso(amounts.discountCentavos, { decimals: true })}`}
            </li>
          )}
          {amounts === null ? null : (
            <li>
              <strong>Total due {peso(amounts.netCentavos, { decimals: true })}</strong>
            </li>
          )}
        </ul>
      </ConfirmDialog>
    </>
  );
}
