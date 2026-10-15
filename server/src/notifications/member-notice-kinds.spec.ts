import { MemberNoticeKind } from '@prisma/client';
import { MEMBER_NOTICE_KINDS } from '@got/shared';

/**
 * Prisma cannot import from @got/shared, so the notice kinds are written down
 * twice: the enum in enums.prisma and the list the wire type is built from. A
 * kind added to one side only would type-check on both and fail at run time —
 * a notice the client's union does not name, or a kind the database refuses.
 *
 * A plain list rather than a TS enum, so enum-parity.spec.ts does not see it;
 * this is its pairing.
 */
describe('MEMBER_NOTICE_KINDS', () => {
  it('names exactly the Prisma MemberNoticeKind values', () => {
    expect([...MEMBER_NOTICE_KINDS].sort()).toEqual(Object.values(MemberNoticeKind).sort());
  });
});
