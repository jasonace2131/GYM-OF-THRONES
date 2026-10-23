import { describe, expect, it } from 'vitest';
import { validateWalkInGuest } from './walkInGuest';
import {
  PAYMENT_REFERENCE_HINT,
  isPaymentReference,
  saleReference,
  saleReferenceProblem,
} from './paymentReference';

describe('validateWalkInGuest', () => {
  const base = { name: 'Ana Cruz', phone: '', emergencyContact: '' };

  it('trims and collapses, and normalises the phone', () => {
    expect(
      validateWalkInGuest({ name: '  Ana   Cruz ', phone: '0917-123-4567', emergencyContact: ' Mom ' }),
    ).toEqual({
      ok: true,
      fields: { guestName: 'Ana Cruz', guestPhone: '+639171234567', guestEmergencyContact: 'Mom' },
    });
  });

  it('accepts a +639 phone as stored', () => {
    expect(validateWalkInGuest({ ...base, phone: '+639171234567' })).toEqual({
      ok: true,
      fields: { guestName: 'Ana Cruz', guestPhone: '+639171234567' },
    });
  });

  it('leaves out blank optional fields', () => {
    expect(validateWalkInGuest(base)).toEqual({ ok: true, fields: { guestName: 'Ana Cruz' } });
  });

  it('accepts an emergency contact of exactly 2 and exactly 200 characters', () => {
    expect(validateWalkInGuest({ ...base, emergencyContact: 'Ma' }).ok).toBe(true);
    expect(validateWalkInGuest({ ...base, emergencyContact: 'x'.repeat(200) }).ok).toBe(true);
  });

  it.each<[Record<string, string>, RegExp]>([
    [{ name: 'A' }, /guest's name/],
    [{ name: 'Ana 2' }, /guest's name/],
    [{ name: 'a'.repeat(61) }, /guest's name/],
    [{ phone: '8123 4567' }, /PH mobile/],
    [{ emergencyContact: 'x' }, /2 to 200 characters/],
    [{ emergencyContact: 'x'.repeat(201) }, /2 to 200 characters/],
  ])('refuses %j with a sentence saying why', (patch, problem) => {
    const result = validateWalkInGuest({ ...base, ...patch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problem).toMatch(problem);
  });
});

describe('isPaymentReference', () => {
  it('holds 4–64 with a letter or digit, trimmed', () => {
    expect(isPaymentReference(' 1234 ')).toBe(true);
    expect(isPaymentReference('1234')).toBe(true);
    expect(isPaymentReference('x'.repeat(64))).toBe(true);
    expect(isPaymentReference('123')).toBe(false);
    expect(isPaymentReference('-----')).toBe(false);
    expect(isPaymentReference('x'.repeat(65))).toBe(false);
  });
});

describe('saleReferenceProblem — a method switch never leaves a stale reference blocking Save', () => {
  it('ignores a reference typed under GCash once the method is cash', () => {
    expect(saleReferenceProblem('GCASH', '12')).toBe(PAYMENT_REFERENCE_HINT);
    expect(saleReferenceProblem('CASH', '12')).toBeNull();
    expect(saleReference('CASH', '12')).toBeUndefined();
  });

  it('needs a valid reference for GCash', () => {
    expect(saleReferenceProblem('GCASH', '  ')).toMatch(/GCash reference/);
    expect(saleReferenceProblem('GCASH', '1234')).toBeNull();
    expect(saleReference('GCASH', ' 1234 ')).toBe('1234');
  });
});
