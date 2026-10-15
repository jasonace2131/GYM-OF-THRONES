import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createRemoteJWKSet } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import type { SupabaseClaims } from './auth.types';
import { verifyAccessToken } from './jwt-verifier';

/**
 * Holds the remote JWKS resolver for Supabase's public signing keys.
 *
 * `createRemoteJWKSet` fetches once, caches, and re-fetches only when it sees
 * an unknown key id — so steady-state verification is local crypto with no
 * network call. Calling `supabase.auth.getUser()` per request instead would
 * put an HTTP round-trip in front of every single endpoint.
 */
@Injectable()
export class JwtVerifierService {
  private readonly keys: JWTVerifyGetKey;
  private readonly issuer: string;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL').replace(/\/+$/, '');
    this.issuer = `${supabaseUrl}/auth/v1`;
    this.keys = createRemoteJWKSet(new URL(`${this.issuer}/.well-known/jwks.json`));
  }

  async verify(token: string): Promise<SupabaseClaims> {
    return verifyAccessToken(token, this.keys, this.issuer);
  }
}
