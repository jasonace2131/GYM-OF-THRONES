import { toPaymentDetail, type PaymentDetailRow } from './payment-detail.presenter';
import { toReceiptDoc } from './receipt.presenter';

const PAYMENT_ID = '9c1f2a44-5b6d-4e7f-8a90-1b2c3d4e5f60';

/**
 * A full row, with every column the projection must REFUSE to forward
 * deliberately populated. A fixture that leaves `proofPath` null would let the
 * absence assertions pass against a presenter that copies it.
 */
const ROW = {
  id: PAYMENT_ID,
  userId: null,
  membershipId: null,
  planId: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  purpose: 'WALK_IN',
  status: 'RECORDED',
  planCode: 'WALKIN',
  planName: 'Walk-in day pass',
  grossCentavos: 9000,
  vatBaseCentavos: 9000,
  discountType: 'NONE',
  discountCentavos: 0,
  netCentavos: 9000,
  vatExempt: false,
  statutoryIdNo: null,
  discountReason: null,
  termMonths: null,
  termStartsOn: null,
  termEndsOn: null,
  method: 'GCASH',
  reference: '6028 871 884223',
  referenceNormalized: '6028871884223',
  gcashVerifiedAt: new Date('2026-09-14T02:10:00.000Z'),
  gcashVerifiedById: 'cccccccc-3333-4333-8333-cccccccccccc',
  receiptNo: null,
  receiptIssued: false,
  proofPath: 'gcash-proof/2026/09/secret-object-key.jpg',
  receivedAt: new Date('2026-09-14T02:00:00.000Z'),
  businessDate: new Date('2026-09-14T00:00:00.000Z'),
  shiftId: 'dddddddd-4444-4444-8444-dddddddddddd',
  recordedById: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  notes: null,
  idempotencyKey: 'walkin:abc123',
  idempotencyHash: 'f'.repeat(64),
  replacesPaymentId: null,
  archivedAt: null,
  archivedById: null,
  voidedAt: null,
  voidedById: null,
  voidReason: null,
  voidKind: null,
  createdAt: new Date('2026-09-14T02:00:00.000Z'),
  updatedAt: new Date('2026-09-14T02:00:00.000Z'),

  user: null,
  recordedBy: { firstName: 'Sam', lastName: 'Tarly' },
  voidedBy: null,
  archivedBy: null,
  gcashVerifiedBy: { firstName: 'Jon', lastName: 'Snow' },
  replacedBy: null,
  checkIn: {
    id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
    occurredAt: new Date('2026-09-14T02:01:00.000Z'),
    guestName: 'Rico M.',
    guestPhone: '+63 917 000 0000',
  },
  membership: null,
} as unknown as PaymentDetailRow;

describe('toPaymentDetail', () => {
  /**
   * A SHAPE assertion, not a spot check.
   *
   * This projection streams to an admin console; `proofPath` is an object key
   * in a private bucket, `referenceNormalized` is the duplicate-detection
   * index's input, the idempotency pair is replay-protection mechanism, and
   * `guestPhone` sits behind `member.create` on a different route entirely.
   * Spot-checking four names would keep passing the day a fifth is added by a
   * spread, which is exactly how a projection like this leaks.
   */
  it('never forwards proofPath, referenceNormalized, the idempotency pair, guestPhone or planId', () => {
    const detail = toPaymentDetail(ROW, { vatRegistered: true });
    const flat = JSON.stringify(detail);

    for (const forbidden of [
      'proofPath',
      'referenceNormalized',
      'idempotencyKey',
      'idempotencyHash',
      'guestPhone',
      'planId',
    ]) {
      expect(Object.keys(detail)).not.toContain(forbidden);
    }

    // And the VALUES, so a rename cannot smuggle one through under a new key.
    expect(flat).not.toContain('secret-object-key');
    expect(flat).not.toContain('6028871884223');
    expect(flat).not.toContain('walkin:abc123');
    expect(flat).not.toContain('+63 917 000 0000');
  });

  it('reports proof as a boolean, never the path', () => {
    expect(toPaymentDetail(ROW, { vatRegistered: true }).hasProof).toBe(true);
    expect(
      toPaymentDetail({ ...ROW, proofPath: null } as PaymentDetailRow, { vatRegistered: true })
        .hasProof,
    ).toBe(false);
  });

  it('carries the walk-in shape: no member code, the guest name from the funded visit', () => {
    const detail = toPaymentDetail(ROW, { vatRegistered: false });

    expect(detail.payerMemberCode).toBeNull();
    expect(detail.userId).toBeNull();
    expect(detail.checkIn).toEqual({
      id: 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee',
      occurredAt: '2026-09-14T02:01:00.000Z',
      guestName: 'Rico M.',
    });
  });

  it('names the actors it has and nulls the ones it does not', () => {
    const detail = toPaymentDetail(ROW, { vatRegistered: true });

    expect(detail.recordedByName).toBe('Sam Tarly');
    expect(detail.voidedByName).toBeNull();
    expect(detail.archivedByName).toBeNull();
    expect(detail.gcashVerified).toBe(true);
    expect(detail.gcashVerifiedByName).toBe('Jon Snow');
    expect(detail.gcashVerifiedAt).toBe('2026-09-14T02:10:00.000Z');
  });

  /**
   * The amendment chain, derived from the ONE stored column in both
   * directions. A stored pair could disagree; this cannot.
   */
  it('exposes both ends of the amendment chain from the single stored column', () => {
    const detail = toPaymentDetail(
      {
        ...ROW,
        replacesPaymentId: '11111111-1111-4111-8111-111111111111',
        replacedBy: { id: '22222222-2222-4222-8222-222222222222' },
      } as unknown as PaymentDetailRow,
      { vatRegistered: true },
    );

    expect(detail.replacesPaymentId).toBe('11111111-1111-4111-8111-111111111111');
    expect(detail.replacedByPaymentId).toBe('22222222-2222-4222-8222-222222222222');
  });

  /**
   * The whole reason `paymentDocNo` was lifted out of `toReceiptDoc`. If these
   * two ever disagree, a member holding a printed slip and an operator reading
   * the drawer are looking at two different document numbers for one payment.
   */
  it('derives the same docNo toReceiptDoc prints for the same row', () => {
    const detail = toPaymentDetail(ROW, { vatRegistered: true });
    const receipt = toReceiptDoc(
      {
        ...ROW,
        user: null,
        recordedBy: { firstName: 'Sam', lastName: 'Tarly' },
      } as never,
      {
        registeredName: null,
        tradeName: null,
        address: null,
        tin: null,
        vatRegistered: true,
      },
      new Date('2026-09-15T00:00:00.000Z'),
    );

    expect(detail.docNo).toBe(receipt.docNo);
  });

  /**
   * The client must never guess this: the amend preview's statutory branch
   * divides by 1.12 only for a VAT-registered seller, and a client that
   * assumed either way would show a figure the server does not write.
   */
  it('forwards vatRegistered so the amend preview is not a client guess', () => {
    expect(toPaymentDetail(ROW, { vatRegistered: true }).vatRegistered).toBe(true);
    expect(toPaymentDetail(ROW, { vatRegistered: false }).vatRegistered).toBe(false);
  });
});
