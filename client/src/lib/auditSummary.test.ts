import { describe, expect, it } from 'vitest';
import { summariseAuditDetails } from './auditSummary';

describe('summariseAuditDetails', () => {
  it('renders a before/after pair as one line', () => {
    expect(
      summariseAuditDetails('PAYMENT_AMENDED', { priceCentavos: { before: 80000, after: 90000 } }),
    ).toBe('priceCentavos: 80000 → 90000');
  });

  it('renders a list of names, a count and a scalar', () => {
    expect(
      summariseAuditDetails('PROGRESS_MEASUREMENT_DELETED', {
        fields: ['weight', 'waist'],
        days: [1, 2, 3],
        note: 'ok',
      }),
    ).toBe('fields: weight, waist · days: 3 · note: ok');
  });

  it('is null for nothing to say', () => {
    expect(summariseAuditDetails('PAYMENT_VOIDED', null)).toBeNull();
    expect(summariseAuditDetails('PAYMENT_VOIDED', {})).toBeNull();
  });

  /**
   * The instructions entries carry the whole text twice, up to 6,000
   * characters each. The subject label ("N → M characters") already says what
   * changed; the text itself stretched the column off the screen.
   */
  it('leaves the instructions text out of an assistant entry', () => {
    const long = 'x'.repeat(6000);

    expect(
      summariseAuditDetails('ASSISTANT_INSTRUCTIONS_UPDATED', {
        before: long,
        after: long,
        wasDefault: true,
      }),
    ).toBeNull();
    expect(summariseAuditDetails('ASSISTANT_INSTRUCTIONS_RESET', { before: long })).toBeNull();
  });

  it('never prints a long free-text value whole', () => {
    const line = summariseAuditDetails('PAYMENT_AMENDED', {
      note: 'n'.repeat(6000),
      memo: { before: 'b'.repeat(6000), after: 'short' },
    });

    expect(line).toBe(`note: ${'n'.repeat(60)}… · memo: ${'b'.repeat(60)}… → short`);
  });

  it('keeps a string of exactly 80 characters whole', () => {
    expect(summariseAuditDetails('PAYMENT_AMENDED', { note: 'a'.repeat(80) })).toBe(
      `note: ${'a'.repeat(80)}`,
    );
  });

  it('never cuts an emoji in half', () => {
    const line = summariseAuditDetails('PAYMENT_AMENDED', { note: '💪'.repeat(100) });
    expect(line).toBe(`note: ${'💪'.repeat(60)}…`);
  });
});
