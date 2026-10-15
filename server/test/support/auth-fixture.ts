import { PrismaClient } from '@prisma/client';
import type { Role } from '@prisma/client';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWTVerifyGetKey, KeyLike } from 'jose';
import { verifyAccessToken } from '../../src/auth/jwt-verifier';
import { UserProvisioningService } from '../../src/auth/user-provisioning.service';
import type { SupabaseClaims } from '../../src/auth/auth.types';
import type { JwtVerifierService } from '../../src/auth/jwt-verifier.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** Issuer used for both signing and verification. Never resolved over the network. */
export const FIXTURE_ISSUER = 'https://fixture.supabase.test/auth/v1';
const FIXTURE_KID = 'fixture-es256';

/** One stable Supabase id per role, so repeat calls resolve the same row. */
const DEFAULT_SUPABASE_IDS: Record<Role, string> = {
  CLIENT: '10000000-0000-4000-8000-000000000001',
  FRONT_DESK: '10000000-0000-4000-8000-000000000002',
  COACH: '10000000-0000-4000-8000-000000000003',
  ADMIN: '10000000-0000-4000-8000-000000000004',
  DEV: '10000000-0000-4000-8000-000000000005',
};

export interface FixtureUserOverrides {
  supabaseId?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
}

/**
 * Local keypair + in-memory JWKS, so e2e never reaches Supabase.
 *
 * ES256, not RSA: jwt-verifier.ts pins `algorithms: ['ES256']`, so an RS256
 * fixture token would be rejected by the exact code these tests exist to
 * exercise. Signature verification is real — only the key source is local.
 *
 * Fixture users are created through the real provisioning path, so a
 * provisioning regression fails the whole suite loudly. `role` is applied
 * afterwards with a direct update, because provisioning deliberately refuses
 * to let a token claim set it.
 */
export class AuthFixture {
  readonly verifier: Pick<JwtVerifierService, 'verify'>;

  private constructor(
    private readonly privateKey: KeyLike,
    private readonly keys: JWTVerifyGetKey,
    private readonly prisma: PrismaClient,
    private readonly provisioning: UserProvisioningService,
  ) {
    this.verifier = {
      verify: (token: string): Promise<SupabaseClaims> =>
        verifyAccessToken(token, this.keys, FIXTURE_ISSUER),
    };
  }

  static async create(): Promise<AuthFixture> {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const jwk = await exportJWK(publicKey);
    const keys = createLocalJWKSet({
      keys: [{ ...jwk, kid: FIXTURE_KID, alg: 'ES256', use: 'sig' }],
    });

    const prisma = new PrismaClient();
    const provisioning = new UserProvisioningService(prisma as unknown as PrismaService);

    return new AuthFixture(privateKey, keys, prisma, provisioning);
  }

  async tokenFor(role: Role, overrides: FixtureUserOverrides = {}): Promise<string> {
    const supabaseId = overrides.supabaseId ?? DEFAULT_SUPABASE_IDS[role];
    const claims: SupabaseClaims = {
      sub: supabaseId,
      // Derived from the id, so two fixtures at one role never collide on
      // User.email's unique index.
      email: overrides.email ?? `${supabaseId}@fixture.test`,
      firstName: overrides.firstName ?? role,
      lastName: overrides.lastName ?? 'Fixture',
      phone: null,
      heightCm: null,
      weightKg: null,
      dateOfBirth: null,
    };

    const user = await this.provisioning.resolve(claims);
    if (user.role !== role) {
      await this.prisma.user.update({ where: { id: user.id }, data: { role } });
    }

    return new SignJWT({
      email: claims.email,
      user_metadata: { firstName: claims.firstName, lastName: claims.lastName },
    })
      .setProtectedHeader({ alg: 'ES256', kid: FIXTURE_KID })
      .setIssuer(FIXTURE_ISSUER)
      .setAudience('authenticated')
      .setSubject(supabaseId)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(this.privateKey);
  }

  async userIdFor(supabaseId: string): Promise<string> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { supabaseId },
      select: { id: true },
    });
    return user.id;
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }
}

/**
 * Stable Supabase subject ids, shared by every e2e spec so two suites cannot
 * accidentally mean different people by "COACH_A". They are minted, never
 * inserted: `tokenFor()` provisions the local row through the real path.
 */
export const FIXTURE_IDS = {
  ADMIN: '0a000000-0000-4000-8000-00000000ad01',
  FRONT_DESK: '0a000000-0000-4000-8000-00000000fd01',
  COACH_A: '0a000000-0000-4000-8000-0000000c0a01',
  COACH_B: '0a000000-0000-4000-8000-0000000c0b01',
  CLIENT_A: '0a000000-0000-4000-8000-0000000c1a01',
  CLIENT_B: '0a000000-0000-4000-8000-0000000c1b01',
  CLIENT_DELETED: '0a000000-0000-4000-8000-0000000cde01',
} as const;
