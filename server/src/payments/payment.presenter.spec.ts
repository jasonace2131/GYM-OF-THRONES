import type { Payment } from '@prisma/client';
import { toPaymentSummary } from './payment.presenter';

/** A RECORDED row — every void/refund field null. */
const RECORDED_ROW: Payment = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  membershipId: null,
  planId: '33333333-3333-4333-8333-333333333333',
  purpose: 'WALK_IN',
  status: 'RECORDED',
  referenceNormalized: null,
  proofPath: null,
  gcashVerifiedAt: null,
  gcashVerifiedById: null,
  planCode: 'DAY',
  planName: 'Day Pass',
  grossCentavos: 10_000,
  vatBaseCentavos: 10_000,
  discountType: 'NONE',
  discountCentavos: 0,
  netCentavos: 10_000,
  vatExempt: false,
  statutoryIdNo: null,
  discountReason: null,
  termMonths: null,
  termStartsOn: null,
  termEndsOn: null,
  method: 'CASH',
  reference: null,
  receiptNo: null,
  receiptIssued: false,
  receivedAt: new Date('2026-08-27T02:00:00.000Z'),
  businessDate: new Date('2026-08-27T00:00:00.000Z'),
  shiftId: '44444444-4444-4444-8444-444444444444',
  recordedById: '55555555-5555-4555-8555-555555555555',
  notes: null,
  idempotencyKey: 'IK_TEST',
  idempotencyHash: 'a'.repeat(64),
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  voidKind: null,
  // A fresh sale corrects nothing and is on the register.
  replacesPaymentId: null,
  archivedAt: null,
  archivedById: null,
  createdAt: new Date('2026-08-27T02:00:00.000Z'),
  updatedAt: new Date('2026-08-27T02:00:00.000Z'),
};

describe('toPaymentSummary — voidKind', () => {
  it('carries voidKind: null for a RECORDED payment', () => {
    expect(toPaymentSummary(RECORDED_ROW).voidKind).toBeNull();
  });

  it('carries voidKind: VOID for a plain void', () => {
    const row: Payment = {
      ...RECORDED_ROW,
      status: 'VOIDED',
      voidedAt: new Date('2026-08-27T03:00:00.000Z'),
      voidedById: '66666666-6666-4666-8666-666666666666',
      voidReason: 'rang the wrong plan',
      voidKind: 'VOID',
    };
    expect(toPaymentSummary(row).voidKind).toBe('VOID');
  });

  it('carries voidKind: REFUND when money was returned', () => {
    const row: Payment = {
      ...RECORDED_ROW,
      status: 'VOIDED',
      voidedAt: new Date('2026-08-27T03:00:00.000Z'),
      voidedById: '66666666-6666-4666-8666-666666666666',
      voidReason: 'member asked for money back',
      voidKind: 'REFUND',
    };
    expect(toPaymentSummary(row).voidKind).toBe('REFUND');
  });
});
