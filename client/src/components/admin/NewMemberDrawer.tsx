'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  adminApi,
  peso,
  type CreateMemberResult,
  type DiscountTypeCode,
  type MemberListItem,
  type PaymentMethodCode,
} from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { DISCOUNTS, DISCRETIONARY } from './actions/SellMembershipModal';
import {
  EMERGENCY_CONTACT_MAX,
  PERMISSIONS,
  STATUTORY_ID_MAX,
  STATUTORY_ID_MIN,
  collapseSpaces,
  isPersonName,
  normalisePhPhone,
} from '@got/shared';
import { CharCounter } from '@/components/inputs/CharCounter';
import { EmailInput } from '@/components/inputs/EmailInput';
import { NameInput } from '@/components/inputs/NameInput';
import { PhoneInput } from '@/components/inputs/PhoneInput';
import { saleReference, saleReferenceProblem } from '@/lib/paymentReference';
import { usePermission } from '@/components/rbac/MeProvider';
import { Drawer } from './Drawer';
import { GcashFields } from './GcashFields';
import { ReceiptNoField } from './ReceiptNoField';
import {
  DiscountAmountField,
  EMPTY_DISCOUNT,
  PriceSummary,
  useVatRegistered,
  type DiscountInput,
} from './DiscountEntry';
import { parseDiscount, saleAmounts } from '@/lib/payments/discount';
import { ModalError } from './Modal';
import { ConfirmDialog } from './actions/ConfirmDialog';
import type { NewMemberSeed } from '@/lib/memberSeed';

/**
 * "+ New member" — C6. A DRAWER, not a modal: the brief's binding ruling is
 * that this is a form, not a confirmation, and `Drawer` is the shell every
 * other member-scoped form-with-real-estate already uses.
 *
 * The optional plan step mirrors `SellMembershipModal`'s fields (same
 * `DISCOUNTS`/`DISCRETIONARY` vocabulary, imported rather than re-typed) —
 * because `POST /members`'s `plan` argument IS `AssignPlanDto`, the exact DTO
 * `sellMembership` sends. One request, "sign up and pay" in one submit, same
 * as a walk-in at the counter.
 *
 * Always mounted only while open (`admin/members/page.tsx` conditionally
 * renders this like `MemberDrawer`), so there is no reset-on-reopen state to
 * manage — a fresh mount is a fresh form. That conditional mount is also what
 * lets `seed` be plain `useState` initializers with no reset effect; a caller
 * re-opening with a different seed remounts, so the seeds are never stale.
 */
export function NewMemberDrawer({
  onClose,
  onCreated,
  onOpenMember,
  seed,
}: {
  onClose: () => void;
  /** Fired once, right after a successful create — the caller reloads its list. */
  onCreated: () => void;
  /** "Open the new member's drawer" — cheap because the create response
   *  already carries the full row, no second fetch. */
  onOpenMember: (member: MemberListItem) => void;
  /** Prefill for the conversion flows — a walk-in guest's visit row, or a
   *  lead. The operator reviews and completes (email is still required);
   *  nothing here submits by itself. */
  seed?: NewMemberSeed;
}) {
  // `POST /members` gates its `plan` argument on `membership.sell`
  // SEPARATELY from `member.create` (MembersService.create) — a role holding
  // only member.create gets a 403 the moment it ticks this box, before the
  // member is even minted. Same gating rule as `MemberDrawer`: hide the
  // control rather than offer a form that can only fail.
  const canSell = usePermission(PERMISSIONS.MEMBERSHIP_SELL);
  const canInviteStaff = usePermission(PERMISSIONS.STAFF_INVITE, { scope: 'ALL' });

  const [firstName, setFirstName] = useState(seed?.firstName ?? '');
  const [lastName, setLastName] = useState(seed?.lastName ?? '');
  const [email, setEmail] = useState(seed?.email ?? '');
  const [phone, setPhone] = useState(seed?.phone ?? '');
  const [emergencyContact, setEmergencyContact] = useState(seed?.emergencyContact ?? '');

  const [sellPlan, setSellPlan] = useState(false);
  const plansQuery = useAdminQuery(useCallback(() => adminApi.plans(), []), 'new-member-plans');
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
  const [result, setResult] = useState<CreateMemberResult | null>(null);
  // Creating an account sends an email (and, with a plan, takes money), so
  // it is confirmed like every other admin write.
  const [confirming, setConfirming] = useState(false);

  // Resend-invite affordance for a fresh create with `emailSent: false`.
  const [resendBusy, setResendBusy] = useState(false);
  const [resendDone, setResendDone] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  /** The ONLY thing the rest of this component reads. `sellPlan` is raw
   *  checkbox state; this is that state AND the permission to act on it, so a
   *  stale `true` can never reach the request body if the gate ever flips. */
  const sellingPlan = canSell && sellPlan;

  useEffect(() => {
    if (sellingPlan && planCode === '' && plans.length > 0) setPlanCode(plans[0]!.code);
  }, [sellingPlan, plans, planCode]);

  const discretionary = DISCRETIONARY.includes(discountType);
  const statutory = discountType === 'SENIOR' || discountType === 'PWD';
  const trimmedDiscountReason = discountReason.trim();

  // The total is derived, never typed — see `DiscountEntry`.
  const selectedPlan = plans.find((plan) => plan.code === planCode) ?? null;
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

  const trimmedFirst = collapseSpaces(firstName);
  const trimmedLast = collapseSpaces(lastName);
  const trimmedEmail = email.trim();
  // Optional, but when given: a PH mobile, sent as +639XXXXXXXXX.
  const phoneOut = phone.trim() === '' ? null : normalisePhPhone(phone);
  const trimmedStatutoryId = statutoryIdNo.trim();
  // Only a GCash sale has a reference; one left over from before switching to
  // cash is ignored, never a silent reason Save stays disabled.
  const referenceProblem = sellingPlan ? saleReferenceProblem(method, reference) : null;
  const statutoryIdProblem =
    statutory && trimmedStatutoryId !== '' && trimmedStatutoryId.length < STATUTORY_ID_MIN
      ? `An OSCA / PWD ID is at least ${STATUTORY_ID_MIN} characters — or leave it blank.`
      : null;
  const valid =
    isPersonName(trimmedFirst) &&
    isPersonName(trimmedLast) &&
    trimmedEmail.length > 0 &&
    (phone.trim() === '' || phoneOut !== null) &&
    (!sellingPlan ||
      (planCode !== '' &&
        referenceProblem === null &&
        statutoryIdProblem === null &&
        (!discretionary ||
          (operatorDiscountCentavos > 0 &&
            trimmedDiscountReason.length >= 3 &&
            trimmedDiscountReason.length <= 200))));

  const requestClose = (): void => {
    if (busy) return;
    onClose();
  };

  const submit = async (): Promise<void> => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const created = await adminApi.createMember({
        firstName: trimmedFirst,
        lastName: trimmedLast,
        email: trimmedEmail,
        phone: phoneOut ?? undefined,
        emergencyContact: emergencyContact.trim() === '' ? undefined : emergencyContact.trim(),
        plan: sellingPlan
          ? {
              planCode,
              discountType: discountType === 'NONE' ? undefined : discountType,
              discountCentavos: discretionary ? operatorDiscountCentavos : undefined,
              statutoryIdNo: statutoryIdNo.trim() === '' ? undefined : statutoryIdNo.trim(),
              discountReason: discountReason.trim() === '' ? undefined : discountReason.trim(),
              method,
              reference: saleReference(method, reference),
              gcashVerified: method === 'GCASH' ? gcashVerified : undefined,
              receiptNo: receiptNo.trim() === '' ? undefined : receiptNo.trim(),
            }
          : undefined,
        leadId: seed?.leadId,
        fromCheckInId: seed?.fromCheckInId,
      });
      setResult(created);
      setConfirming(false);
      setBusy(false);
      // The row now exists on the server regardless of what the operator does
      // next in this drawer — reload the list right away.
      onCreated();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  const resendInvite = async (): Promise<void> => {
    if (result === null) return;
    setResendBusy(true);
    setResendError(null);
    try {
      const { emailSent } = await adminApi.resendInvite(result.member.userId);
      // A 200 is not "sent": on `emailSent: false` the hint stays and so does the button.
      if (emailSent) setResendDone(true);
      else setResendError('That one may not have gone out either. Try again in a moment.');
    } catch (caught) {
      setResendError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setResendBusy(false);
    }
  };

  const planName = plans.find((plan) => plan.code === planCode)?.name ?? planCode;

  return (
    <Drawer open label="New member" busy={busy} onClose={onClose}>
      <div className="a-drawer-head">
        <div className="a-drawer-head-main">
          <span className="a-person-name">{result === null ? 'New member' : 'Member created'}</span>
        </div>
        <div className="a-drawer-head-actions">
          <button
            type="button"
            className="a-modal-x"
            onClick={requestClose}
            disabled={busy}
            aria-label="Close"
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="a-drawer-body">
        {result === null ? (
          <>
            {/* Staff & Access: this drawer only ever creates MEMBERS. Staff
                join by invitation, which carries the role — so the shortcut
                sits here, where somebody adding a new coach would look first. */}
            {canInviteStaff ? (
              <p className="a-field-hint" style={{ margin: 0 }}>
                Adding front desk, a coach or an admin?{' '}
                <Link href="/admin/staff" style={{ color: 'var(--gold-dark)' }}>
                  Invite them from Staff &amp; Access
                </Link>
                .
              </p>
            ) : null}
            <div className="a-field">
              <label className="a-field-label" htmlFor="new-member-first">
                First name
              </label>
              <NameInput
                id="new-member-first"
                className="a-input"
                value={firstName}
                autoComplete="off"
                autoFocus
                onChange={setFirstName}
              />
            </div>

            <div className="a-field">
              <label className="a-field-label" htmlFor="new-member-last">
                Last name
              </label>
              <NameInput
                id="new-member-last"
                className="a-input"
                value={lastName}
                autoComplete="off"
                onChange={setLastName}
              />
            </div>

            <div className="a-field">
              <label className="a-field-label" htmlFor="new-member-email">
                Email
              </label>
              <EmailInput
                id="new-member-email"
                className="a-input"
                value={email}
                autoComplete="off"
                onChange={setEmail}
              />
            </div>

            <div className="a-field">
              <label className="a-field-label" htmlFor="new-member-phone">
                Phone <span className="a-field-opt">optional</span>
              </label>
              <PhoneInput
                id="new-member-phone"
                className="a-input"
                value={phone}
                autoComplete="off"
                onChange={setPhone}
              />
            </div>

            <div className="a-field">
              <label className="a-field-label" htmlFor="new-member-emergency">
                Emergency contact <span className="a-field-opt">optional</span>
              </label>
              <input
                id="new-member-emergency"
                className="a-input"
                value={emergencyContact}
                autoComplete="off"
                maxLength={EMERGENCY_CONTACT_MAX}
                aria-describedby="new-member-emergency-count"
                placeholder="Name, relation, phone — free text"
                onChange={(event) => setEmergencyContact(event.target.value)}
              />
              <CharCounter
                id="new-member-emergency-count"
                value={emergencyContact}
                max={EMERGENCY_CONTACT_MAX}
              />
            </div>

            {canSell && (
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={sellPlan}
                  onChange={(event) => setSellPlan(event.target.checked)}
                />
                Sell a plan now
              </label>
            )}

            {sellingPlan && (
              <>
                <div className="a-field">
                  <label className="a-field-label" htmlFor="new-member-plan">
                    Plan
                  </label>
                  <select
                    id="new-member-plan"
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
                        onClick={() => {
                          setMethod(option);
                          if (option !== 'GCASH') {
                            setReference('');
                            setGcashVerified(false);
                          }
                        }}
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


                <ReceiptNoField
                  value={receiptNo}
                  onChange={setReceiptNo}
                  highlight={statutory}
                />

                <div className="a-field">
                  <label className="a-field-label" htmlFor="new-member-discount">
                    Discount
                  </label>
                  <select
                    id="new-member-discount"
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
                    <label className="a-field-label" htmlFor="new-member-statutory-id">
                      OSCA / PWD ID <span className="a-field-opt">optional</span>
                    </label>
                    <input
                      id="new-member-statutory-id"
                      className="a-input"
                      value={statutoryIdNo}
                      maxLength={STATUTORY_ID_MAX}
                      autoComplete="off"
                      onChange={(event) => setStatutoryIdNo(event.target.value)}
                    />
                    {statutoryIdProblem !== null ? (
                      <p className="a-field-hint" data-tone="danger" role="alert">
                        {statutoryIdProblem}
                      </p>
                    ) : null}
                  </div>
                )}

                {discretionary && (
                  <>
                    <DiscountAmountField
                      id="new-member-discount-amount"
                      value={discount}
                      onChange={setDiscount}
                      priceCentavos={selectedPlan?.priceCentavos ?? null}
                      parsed={parsedDiscount}
                    />

                    <div className="a-field">
                      <label className="a-field-label" htmlFor="new-member-discount-reason">
                        Discount reason
                      </label>
                      <input
                        id="new-member-discount-reason"
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
              </>
            )}

            <ModalError message={error ?? (sellingPlan ? plansQuery.error : null)} />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
              <button type="button" className="p-btn p-btn-ghost" onClick={requestClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="p-btn p-btn-gold"
                onClick={() => {
                  setError(null);
                  setConfirming(true);
                }}
                disabled={busy || !valid}
              >
                {busy ? 'Creating…' : 'Create member'}
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ margin: 0 }}>
              {result.member.firstName} {result.member.lastName} was created.
              {result.emailSent
                ? ` Their setup link was emailed to ${result.member.email} — it works once, for 7 days.`
                : ''}
            </p>

            {!result.emailSent && (
              <div className="a-field">
                <p className="a-field-hint" style={{ margin: 0 }}>
                  The setup link email may not have gone out. Check the address — fix it with Change
                  email in the member&apos;s drawer — then resend.
                </p>
                {resendDone ? (
                  <p className="a-field-hint" style={{ margin: 0, color: 'var(--p-ok)' }}>
                    Setup link sent.
                  </p>
                ) : (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => void resendInvite()}
                    disabled={resendBusy}
                  >
                    {resendBusy ? 'Sending…' : 'Resend invite'}
                  </button>
                )}
                <ModalError message={resendError} />
              </div>
            )}

            {result.planSaleError !== undefined && (
              <div className="a-modal-err" role="alert">
                Member created, but the plan sale failed: {result.planSaleError.message}. Assign a
                plan from the member&apos;s drawer to retry.
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 9 }}>
              <button type="button" className="p-btn p-btn-ghost" onClick={onClose}>
                Done
              </button>
              <button
                type="button"
                className="p-btn p-btn-gold"
                onClick={() => {
                  const member = result.member;
                  onClose();
                  onOpenMember(member);
                }}
              >
                View member
              </button>
            </div>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirming && result === null}
        title={`Create an account for ${trimmedFirst} ${trimmedLast}?`}
        consequence={
          sellingPlan
            ? `Emails them a setup link at ${trimmedEmail} and takes the ${planName} payment by ${method === 'CASH' ? 'cash' : 'GCash'}.`
            : `Emails them a setup link at ${trimmedEmail} so they can sign in to the member portal.`
        }
        confirmLabel="Create member"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </Drawer>
  );
}
