import type { KeyboardEvent } from 'react';

/**
 * Number fields without the browser's surprises (owner, 2026-10-23):
 * `type="number"` lets `e`, `+` and `-` in, and `Number('')` is 0 — so a
 * cleared "capacity" silently became zero. These keep typing to what the field
 * means and read a blank as "nothing", never as 0.
 */

/** Digits only (whole, non-negative numbers). */
export function filterIntTyping(raw: string): string {
  return raw.replace(/\D/g, '');
}

/** Digits and one dot, at most `maxDecimals` after it (money: 2). */
export function filterDecimalTyping(raw: string, maxDecimals = 2): string {
  const cleaned = raw.replace(/[^\d.]/g, '');
  const dot = cleaned.indexOf('.');
  if (dot === -1) return cleaned;
  const whole = cleaned.slice(0, dot);
  const fraction = cleaned.slice(dot + 1).replace(/\./g, '').slice(0, maxDecimals);
  return maxDecimals === 0 ? whole : `${whole}.${fraction}`;
}

/** A whole number inside [min, max], or null for blank or anything else. */
export function parseIntField(raw: string, min: number, max: number): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

/** A whole number as typed, or NaN when blank or not whole — never 0 for blank. */
export function wholeOrNaN(raw: string): number {
  const trimmed = raw.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** A non-negative amount with at most `maxDecimals` decimals inside [min, max], or null. */
export function parseDecimalField(
  raw: string,
  min: number,
  max: number,
  maxDecimals = 2,
): number | null {
  const trimmed = raw.trim();
  const pattern = new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`);
  if (maxDecimals === 0 ? !/^\d+$/.test(trimmed) : !pattern.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Pesos as typed ("1500.5") → centavos (150050), or null. */
export function parsePesosToCentavos(raw: string, maxPesos: number): number | null {
  const pesos = parseDecimalField(raw, 0, maxPesos, 2);
  return pesos === null ? null : Math.round(pesos * 100);
}

/** The goal API's value bounds: ±1,000,000 (stored in hundredths, ±100,000,000). */
export const GOAL_VALUE_LIMIT = 1_000_000;

const EXPONENT_KEYS = new Set(['e', 'E', '+']);

/** `onKeyDown` for a signed `type="number"` field: refuses e, E and + but keeps -. */
export function blockExponentKeys(event: KeyboardEvent<HTMLInputElement>): void {
  if (EXPONENT_KEYS.has(event.key)) event.preventDefault();
}

const BLOCKED_NUMBER_KEYS = new Set(['e', 'E', '+', '-']);

/** `onKeyDown` for a `type="number"` field: refuses e, E, + and -. */
export function blockNumberJunk(event: KeyboardEvent<HTMLInputElement>): void {
  if (BLOCKED_NUMBER_KEYS.has(event.key)) event.preventDefault();
}

/** `onKeyDown` for a whole-number `type="number"` field: also refuses the dot. */
export function blockIntJunk(event: KeyboardEvent<HTMLInputElement>): void {
  if (BLOCKED_NUMBER_KEYS.has(event.key) || event.key === '.' || event.key === ',') {
    event.preventDefault();
  }
}
