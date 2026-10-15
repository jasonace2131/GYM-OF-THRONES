import { MemberCodeService, MEMBER_CODE_SLOT_SECONDS } from './member-code.service';

const SECRET = 'a'.repeat(44);
const OTHER_SECRET = 'b'.repeat(44);
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER_USER = '22222222-2222-4222-8222-222222222222';
const CODE = 'A1B2C3';

describe('MemberCodeService', () => {
  const service = new MemberCodeService();
  // A fixed instant, so the slot maths is asserted rather than sampled.
  const now = new Date('2026-08-26T10:00:30.000Z');
  const slot = service.computeSlot(now);

  const payloadFor = (
    over: { userId?: string; slot?: number; secret?: string; code?: string } = {},
  ): string =>
    service.buildPayload(
      over.code ?? CODE,
      over.slot ?? slot,
      service.sign(over.userId ?? USER, over.slot ?? slot, over.secret ?? SECRET),
    );

  const verify = (payload: string, member: { userId: string } | null = { userId: USER }) =>
    service.verify({ payload, member, secrets: [SECRET], now });

  it('accepts a code it just signed', () => {
    expect(verify(payloadFor())).toEqual({ kind: 'VALID', userId: USER, memberCode: CODE });
  });

  it('accepts the previous slot, so a code does not die in the member’s hand', () => {
    expect(verify(payloadFor({ slot: slot - 1 })).kind).toBe('VALID');
  });

  it('rejects a slot older than that, and says how stale', () => {
    expect(verify(payloadFor({ slot: slot - 4 }))).toEqual({
      kind: 'EXPIRED',
      stalenessSeconds: 4 * MEMBER_CODE_SLOT_SECONDS,
    });
  });

  it('rejects a future slot as a clock alarm rather than a denial', () => {
    expect(verify(payloadFor({ slot: slot + 2 }).valueOf()).kind).toBe('NOT_YET_VALID');
  });

  /**
   * THE POINT OF SIGNING IT AT ALL.
   *
   * A bare memberCode never changes, so a screenshot works forever. Binding it
   * to a slot is what makes a member-held credential acceptable — and this is
   * the assertion that the binding is real.
   */
  it('rejects a forged MAC', () => {
    const forged = service.buildPayload(CODE, slot, 'ZZZZZZZZZZZZZZZZ');
    expect(verify(forged)).toEqual({ kind: 'INVALID' });
  });

  it('rejects a MAC signed with a different secret', () => {
    expect(verify(payloadFor({ secret: OTHER_SECRET })).kind).toBe('INVALID');
  });

  /**
   * The MAC covers the USER ID, not the member code — so one member's
   * signature cannot be replayed under another member's code even if the codes
   * were somehow swapped.
   */
  it('rejects a MAC minted for a different member', () => {
    expect(verify(payloadFor({ userId: OTHER_USER })).kind).toBe('INVALID');
  });

  /**
   * An unknown code and a forged MAC are indistinguishable on purpose.
   * Distinguishing them turns the desk scanner into an oracle for which
   * six-character codes are real, and 32^6 is only about a billion.
   */
  it('reports an unknown member code exactly like a forgery', () => {
    expect(verify(payloadFor(), null)).toEqual({ kind: 'INVALID' });
  });

  it('accepts an older secret during a rotation, but never signs with one', () => {
    const signedWithOld = payloadFor({ secret: OTHER_SECRET });
    expect(
      service.verify({
        payload: signedWithOld,
        member: { userId: USER },
        secrets: [SECRET, OTHER_SECRET],
        now,
      }).kind,
    ).toBe('VALID');
  });

  describe('payload shape', () => {
    it.each([
      ['GOTS1.A1B2C3.28000000.AAAAAAAAAAAAAAAA', 'a STATION token must never verify here'],
      ['GOTM1.A1B2C.28000000.AAAAAAAAAAAAAAAA', 'member code too short'],
      ['GOTM1.A1B2C3.28000000.AAAA', 'mac too short'],
      ['GOTM1.A1B2CI.28000000.AAAAAAAAAAAAAAAA', 'I is not in the alphabet'],
      ['GOTM1.A1B2C3..AAAAAAAAAAAAAAAA', 'no slot'],
      ['', 'empty'],
    ])('rejects %p (%s)', (payload) => {
      expect(service.parsePayload(payload)).toBeNull();
      expect(verify(payload)).toEqual({ kind: 'INVALID' });
    });
  });

  describe('slot maths', () => {
    it('advances once per slot period', () => {
      const later = new Date(now.getTime() + MEMBER_CODE_SLOT_SECONDS * 1000);
      expect(service.computeSlot(later)).toBe(slot + 1);
    });

    it('reports the slot’s own bounds, not the verifier’s tolerance', () => {
      const { notBefore, notAfter } = service.slotBounds(slot);
      expect(notAfter.getTime() - notBefore.getTime()).toBe(MEMBER_CODE_SLOT_SECONDS * 1000);
      expect(notBefore.getTime()).toBeLessThanOrEqual(now.getTime());
      expect(notAfter.getTime()).toBeGreaterThan(now.getTime());
    });
  });
});
