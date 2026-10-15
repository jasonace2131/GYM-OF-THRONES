'use client';

import { useCallback } from 'react';
import type { Amounts } from '@got/shared';
import { adminApi, peso, type DiscountTypeCode } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import {
  PERCENT_PRESETS,
  cleanDiscountInput,
  isStatutory,
  percentOf,
  type DiscountMode,
  type ParsedDiscount,
} from '@/lib/payments/discount';

/**
 * The discount box and the price summary every sale screen shares
 * (owner, 2026-10-08: "the price does not change … the exact figure should
 * not be changed manually").
 *
 * The operator enters a percentage or a peso amount; the summary underneath
 * shows the list price, what comes off it and the total due, recomputed on
 * every keystroke by the same shared arithmetic the server saves with. There
 * is no box for the total anywhere.
 */

export interface DiscountInput {
  mode: DiscountMode;
  /** What is in the box, as typed (already cleaned of anything but digits and a point). */
  input: string;
}

export const EMPTY_DISCOUNT: DiscountInput = { mode: 'PERCENT', input: '' };

/** The short names the summary uses: "Promo discount (10%)". */
const DISCOUNT_NAMES: Record<DiscountTypeCode, string | null> = {
  NONE: null,
  SENIOR: 'Senior citizen',
  PWD: 'PWD',
  PROMO: 'Promo',
  STAFF: 'Staff',
  GUEST_PASS: 'Guest pass',
  GOODWILL: 'Goodwill',
};

/**
 * Whether the gym is VAT-registered, from the public config — `null` while it
 * loads. Only a statutory discount's arithmetic depends on it.
 */
export function useVatRegistered(): boolean | null {
  const config = useAdminQuery(
    useCallback(() => adminApi.gymConfig(), []),
    'gym-config',
  );
  return config.data?.vatRegistered ?? null;
}

function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

export function DiscountAmountField({
  id,
  value,
  onChange,
  priceCentavos,
  parsed,
}: {
  id: string;
  value: DiscountInput;
  onChange: (next: DiscountInput) => void;
  /** The list price the discount comes off; `null` until a plan is chosen. */
  priceCentavos: number | null;
  parsed: ParsedDiscount;
}) {
  const hintId = `${id}-hint`;

  // Switching unit keeps the same discount: 10% of ₱1,500 becomes ₱150.
  const switchMode = (mode: DiscountMode): void => {
    if (mode === value.mode) return;
    if (parsed.kind !== 'ok' || priceCentavos === null || priceCentavos === 0) {
      onChange({ mode, input: value.input });
      return;
    }
    const input =
      mode === 'AMOUNT'
        ? trimNumber(parsed.centavos / 100)
        : trimNumber((parsed.centavos / priceCentavos) * 100);
    onChange({ mode, input });
  };

  const hint =
    parsed.kind === 'invalid'
      ? parsed.message
      : parsed.kind === 'empty'
        ? 'Enter a percentage or a peso amount.'
        : priceCentavos === null
          ? null
          : value.mode === 'PERCENT'
            ? `${peso(parsed.centavos, { decimals: true })} off ${peso(priceCentavos, { decimals: true })}`
            : `${percentOf(parsed.centavos, priceCentavos) ?? '0%'} of ${peso(priceCentavos, { decimals: true })}`;

  return (
    <div className="a-field">
      <label className="a-field-label" htmlFor={id}>
        Discount amount
      </label>
      <div className="a-disc">
        <div className="a-range a-disc-mode" role="radiogroup" aria-label="Discount as">
          {(
            [
              ['PERCENT', '%', 'Percent'],
              ['AMOUNT', '₱', 'Pesos'],
            ] as const
          ).map(([mode, glyph, name]) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={value.mode === mode}
              aria-label={name}
              className="a-range-btn"
              onClick={() => switchMode(mode)}
            >
              {glyph}
            </button>
          ))}
        </div>

        <div className="a-disc-box" data-invalid={parsed.kind === 'invalid' || undefined}>
          {value.mode === 'AMOUNT' ? (
            <span className="a-disc-affix" aria-hidden>
              ₱
            </span>
          ) : null}
          <input
            id={id}
            className="a-disc-input"
            inputMode="decimal"
            autoComplete="off"
            placeholder={value.mode === 'PERCENT' ? '0' : '0.00'}
            value={value.input}
            aria-invalid={parsed.kind === 'invalid' || undefined}
            aria-describedby={hintId}
            onChange={(event) =>
              onChange({ mode: value.mode, input: cleanDiscountInput(event.target.value) })
            }
          />
          {value.mode === 'PERCENT' ? (
            <span className="a-disc-affix" aria-hidden>
              %
            </span>
          ) : null}
        </div>

        <div className="a-disc-chips" role="group" aria-label="Common discounts">
          {PERCENT_PRESETS.map((percent) => (
            <button
              key={percent}
              type="button"
              className="a-disc-chip"
              aria-pressed={value.mode === 'PERCENT' && Number(value.input) === percent}
              onClick={() => onChange({ mode: 'PERCENT', input: String(percent) })}
            >
              {percent}%
            </button>
          ))}
        </div>
      </div>
      <p
        id={hintId}
        className="a-field-hint"
        data-tone={parsed.kind === 'invalid' ? 'danger' : undefined}
      >
        {hint}
      </p>
    </div>
  );
}

/**
 * List price, what comes off, total due. Read-only by construction.
 *
 * `amounts` is `null` while something it needs is unknown (no plan picked
 * yet, the VAT status still loading) or the figures are refused — the total
 * then reads as a dash rather than a guess.
 */
export function PriceSummary({
  itemName,
  amounts,
  discountType,
  wasCentavos,
}: {
  itemName: string | null;
  amounts: Amounts | null;
  /** `''` and `'NONE'` both mean no discount (the walk-in sheet uses `''`). */
  discountType: DiscountTypeCode | '';
  /** For a correction: what the original payment was. */
  wasCentavos?: number;
}) {
  const discountName = discountType === '' ? null : DISCOUNT_NAMES[discountType];
  const vatRemoved =
    amounts !== null && amounts.vatExempt ? amounts.grossCentavos - amounts.vatBaseCentavos : 0;
  // SENIOR/PWD are always 20% — of the VAT-exclusive base for a VAT seller.
  const share =
    amounts === null
      ? null
      : isStatutory(discountType)
        ? '20%'
        : percentOf(amounts.discountCentavos, amounts.grossCentavos);

  return (
    <div className="a-summary" aria-live="polite">
      <div className="a-summary-row">
        <span>{itemName === null ? 'List price' : `${itemName} · list price`}</span>
        <span className="a-summary-amt">
          {amounts === null ? '—' : peso(amounts.grossCentavos, { decimals: true })}
        </span>
      </div>

      {vatRemoved > 0 ? (
        <div className="a-summary-row" data-tone="muted">
          <span>VAT removed (exempt sale)</span>
          <span className="a-summary-amt">−{peso(vatRemoved, { decimals: true })}</span>
        </div>
      ) : null}

      {amounts !== null && discountName !== null && amounts.discountCentavos > 0 ? (
        <div className="a-summary-row" data-tone="discount">
          <span>
            {discountName} discount{share === null ? '' : ` (${share})`}
          </span>
          <span className="a-summary-amt">
            −{peso(amounts.discountCentavos, { decimals: true })}
          </span>
        </div>
      ) : null}

      <div className="a-summary-total">
        <span>Total due</span>
        <strong className="a-summary-amt">
          {amounts === null ? '—' : peso(amounts.netCentavos, { decimals: true })}
        </strong>
      </div>

      {wasCentavos === undefined ? null : (
        <div className="a-summary-was">
          Was {peso(wasCentavos, { decimals: true })}
          {amounts === null || amounts.netCentavos === wasCentavos
            ? ''
            : ` · ${amounts.netCentavos > wasCentavos ? '+' : '−'}${peso(
                Math.abs(amounts.netCentavos - wasCentavos),
                { decimals: true },
              )}`}
        </div>
      )}
    </div>
  );
}
