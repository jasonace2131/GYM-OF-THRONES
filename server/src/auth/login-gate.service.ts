import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthSession } from './auth.types';

/** Verified sign-ins remembered in memory, per instance. */
export const VERIFIED_SESSION_CACHE_SIZE = 10_000;

/**
 * THE ONE PLACE that decides whether a sign-in has passed the emailed code.
 *
 * Verified when the kill switch is off, when the sign-in came from an email
 * link (`amr`), or when its `LoginVerification` row has `verifiedAt`. Both
 * AuthGuard and StationTokenAccessGuard's staff path call `assertVerified`,
 * so the two can never disagree.
 *
 * Only POSITIVE answers are cached (a bounded LRU: a hit re-inserts, a full
 * cache drops the coldest). An unverified answer is re-read every time, so a
 * code entered on one request counts on the very next one. Verification is
 * permanent for a sign-in, so a cached "yes" never goes stale.
 */
@Injectable()
export class LoginGateService {
  readonly required: boolean;
  private readonly verified = new Map<string, true>();

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.required = config.get('LOGIN_CODE_REQUIRED', { infer: true });
  }

  async isVerified(session: AuthSession): Promise<boolean> {
    if (!this.required || session.viaEmailLink) return true;
    if (this.verified.has(session.sessionId)) {
      this.remember(session.sessionId);
      return true;
    }

    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
      select: { verifiedAt: true },
    });
    if (row === null || row.verifiedAt === null) return false;

    this.remember(session.sessionId);
    return true;
  }

  /** Marks a sign-in verified in this instance's cache (and refreshes its recency). */
  remember(sessionId: string): void {
    this.verified.delete(sessionId);
    this.verified.set(sessionId, true);
    if (this.verified.size > VERIFIED_SESSION_CACHE_SIZE) {
      const coldest = this.verified.keys().next().value;
      if (coldest !== undefined) this.verified.delete(coldest);
    }
  }

  async assertVerified(session: AuthSession, exempt: boolean): Promise<void> {
    if (exempt) return;
    if (await this.isVerified(session)) return;
    throw new DomainException(
      'LOGIN_CODE_REQUIRED',
      'Enter the 6-digit code we emailed you to finish signing in.',
      HttpStatus.UNAUTHORIZED,
    );
  }
}
