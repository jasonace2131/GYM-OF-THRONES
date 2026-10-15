import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';
import type { PrismaClient, Station } from '@prisma/client';

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function randomStationCode(): string {
  const bytes = nodeRandomBytes(4);
  let code = '';
  for (let i = 0; i < 4; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return code;
}

export interface StationOverrides {
  code?: string;
  name?: string;
  isActive?: boolean;
  tokenEpoch?: number;
}

/**
 * `resetDatabase` truncates `Station` along with everything else it does not
 * own, so every e2e suite touching the station-token surface seeds its own
 * row(s) — mirroring `membership-fixtures.ts`'s `seedPlansForTest` pattern.
 */
export async function seedStationForTest(
  prisma: PrismaClient,
  overrides: StationOverrides = {},
): Promise<Station> {
  return prisma.station.create({
    data: {
      code: overrides.code ?? randomStationCode(),
      name: overrides.name ?? 'Front desk',
      gymCode: 'GOT',
      isActive: overrides.isActive ?? true,
      tokenEpoch: overrides.tokenEpoch ?? 1,
    },
  });
}

/**
 * Creates a `StationCredential` the way the (not-yet-built) admin endpoint
 * eventually will: a CSPRNG secret, hashed with the pepper before storage,
 * returned to the caller ONCE. `pepper` is read by the caller from
 * `process.env['STATION_CREDENTIAL_PEPPER']`, already populated by
 * `loadTestEnv()` — this file never opens an `.env` file itself.
 */
export async function createStationCredentialForTest(
  prisma: PrismaClient,
  params: { stationId: string; createdById: string; pepper: string; label?: string },
): Promise<string> {
  const secret = nodeRandomBytes(24).toString('hex');
  const keyHash = createHash('sha256')
    .update(secret + params.pepper)
    .digest('hex');

  await prisma.stationCredential.create({
    data: {
      stationId: params.stationId,
      keyHash,
      label: params.label ?? 'Test tablet',
      createdById: params.createdById,
    },
  });

  return secret;
}
