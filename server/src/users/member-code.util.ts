import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { CODE_ALPHABET, MEMBER_CODE_LENGTH } from '@got/shared';

/**
 * Six characters of Crockford base32, CSPRNG-drawn.
 *
 * Not sequential: this string is printed on a card and accepted as a lookup
 * handle by manual check-in, so a sequential code would let anyone walk the
 * roster. 32^6 ~= 1.07e9 makes both collision and enumeration uninteresting.
 *
 * The alphabet excludes I, L, O and U because this is a HUMAN channel — staff
 * type it at the counter with a queue behind them and read it back over the
 * phone. That is what stops a one/I or zero/O mis-key.
 *
 * 256 is an exact multiple of 32, so `% 32` is a uniform draw and needs no
 * rejection sampling.
 */
export function generateMemberCode(
  randomBytes: (size: number) => Buffer = nodeRandomBytes,
): string {
  const bytes = randomBytes(MEMBER_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < MEMBER_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

/**
 * Allocates a free code inside a transaction.
 *
 * Deliberately a READ, never a speculative insert: inside `prisma.$transaction`
 * a unique violation aborts the whole transaction (§4.6d), so probing by
 * INSERT would kill the very transaction this is called from. `User.memberCode
 * @unique` remains the real backstop, and a P2002 on it — vanishingly unlikely
 * at 1.07e9 — surfaces through mapPrismaError and is retried by the client at
 * the request level, never inside this tx.
 *
 * Called from chunk 1's first membership or day-pass transaction. NEVER at
 * provisioning: that path must stay a single upsert on the per-request hot
 * path, and staff accounts would burn codes they never use.
 */
export async function allocateMemberCode(
  tx: Prisma.TransactionClient,
  maxAttempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const code = generateMemberCode();
    const clash = await tx.user.findFirst({ where: { memberCode: code }, select: { id: true } });
    if (!clash) return code;
  }

  throw new Error(`Could not allocate a unique memberCode after ${maxAttempts} attempts`);
}
