import { randomBytes as nodeRandomBytes } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { CODE_ALPHABET, STATION_CODE_LENGTH } from '@got/shared';

/**
 * The one seeded `Station` row — mirrors `plan-registry.ts`'s shape with the
 * same deliberate difference from the permission catalogue: this is
 * CREATE-ONLY, not convergent.
 *
 * A convergent seed would regenerate `code` on every deploy, and `code` is
 * physically printed on a label under the screen (§6.3) — silently changing
 * it invalidates that label without anyone touching the tablet. So the guard
 * here is "does ANY Station row already exist", not "does this one row exist
 * by name": the first deploy creates 'Front desk' with a fresh CSPRNG code,
 * and every deploy after that is a no-op regardless of what the row is later
 * renamed to or how many stations a second branch has added by hand.
 */
export function generateStationCode(
  randomBytes: (size: number) => Buffer = nodeRandomBytes,
): string {
  const bytes = randomBytes(STATION_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < STATION_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

export async function seedStationRegistry(
  prisma: PrismaClient,
): Promise<{ created: boolean; code: string | null }> {
  const existing = await prisma.station.count();
  if (existing > 0) {
    return { created: false, code: null };
  }

  const station = await prisma.station.create({
    data: { name: 'Front desk', gymCode: 'GOT', code: generateStationCode() },
  });

  return { created: true, code: station.code };
}
