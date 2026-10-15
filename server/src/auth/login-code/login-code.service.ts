import { HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { DomainException } from '../../common/exceptions/domain.exception';
import type { Env } from '../../config/env.validation';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { maskEmail } from '../../staff-invitations/invitation-token';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginGateService } from '../login-gate.service';
import {
  LOGIN_CODE_HOUR_MS,
  LOGIN_CODE_MAX_ATTEMPTS,
  LOGIN_CODE_MAX_SENDS_PER_HOUR,
  LOGIN_CODE_MAX_SENDS_PER_SIGN_IN,
  LOGIN_CODE_RESEND_COOLDOWN_MS,
  LOGIN_CODE_TTL_MS,
} from './login-code.constants';
import { generateLoginCode, hashLoginCode, loginCodeMatches } from './login-code.crypto';

interface CodeRow {
  sessionId: string;
  userId: string;
  codeHash: string | null;
  codeExpiresAt: Date | null;
  attempts: number;
  sendCount: number;
  lastSentAt: Date | null;
  verifiedAt: Date | null;
  createdAt: Date;
}

/**
 * Issues and checks the emailed sign-in code for ONE Supabase sign-in.
 *
 * CONCURRENCY. Two tabs, a double tap, or a resend racing a verify all hit
 * the same row. Every write is an `updateMany` guarded on what was read (the
 * send count for a send, the code hash for a verify or a miss), so a lost
 * race changes nothing and is re-read rather than overwritten. The row is
 * created with `createMany({ skipDuplicates })`, never by catching a unique
 * violation (CLAUDE.md).
 *
 * TIME. `createdAt` is written from this process's clock, and `verifiedAt` is
 * clamped to at least `createdAt`, so a database clock ahead of ours can
 * never trip LoginVerification_verified_after_created.
 */
@Injectable()
export class LoginCodeService {
  private readonly logger = new Logger(LoginCodeService.name);
  private readonly pepper: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly email: EmailService,
    private readonly gate: LoginGateService,
  ) {
    this.pepper = config.get('IP_HASH_PEPPER', { infer: true });
  }

  async send(user: AuthUser, session: AuthSession): Promise<LoginCodeSendResult> {
    if (await this.gate.isVerified(session)) return { verified: true };

    const now = new Date();
    await this.prisma.loginVerification.createMany({
      data: [{ sessionId: session.sessionId, userId: user.id, createdAt: now }],
      skipDuplicates: true,
    });
    const row = await this.load(user, session);
    if (row.verifiedAt !== null) {
      this.gate.remember(session.sessionId);
      return { verified: true };
    }

    const pending = this.pendingState(user, row, now);
    if (pending !== null) return pending;

    if (row.sendCount >= LOGIN_CODE_MAX_SENDS_PER_SIGN_IN) throw this.sendLimit();
    if ((await this.sentInLastHour(user.id, now)) >= LOGIN_CODE_MAX_SENDS_PER_HOUR) {
      throw this.sendLimit();
    }
    if (!this.email.enabled) throw this.emailFailed();

    const code = generateLoginCode();
    const codeHash = hashLoginCode(this.pepper, session.sessionId, code);
    const expiresAt = new Date(now.getTime() + LOGIN_CODE_TTL_MS);

    // Claim the send. `sendCount` is the version: every send bumps it, so a
    // concurrent send that got here first makes this match nothing.
    const claimed = await this.prisma.loginVerification.updateMany({
      where: { sessionId: session.sessionId, verifiedAt: null, sendCount: row.sendCount },
      data: {
        codeHash,
        codeExpiresAt: expiresAt,
        attempts: 0,
        sendCount: { increment: 1 },
        lastSentAt: now,
      },
    });
    if (claimed.count === 0) {
      const fresh = await this.load(user, session);
      if (fresh.verifiedAt !== null) {
        this.gate.remember(session.sessionId);
        return { verified: true };
      }
      // The winner's code is the live one. If there is none, the winner's
      // email failed and was un-counted — say so rather than send a second.
      const winner = this.pendingState(user, fresh, now);
      if (winner === null) throw this.emailFailed();
      return winner;
    }

    try {
      await this.email.sendLoginCode(user.email, { name: user.firstName, code });
    } catch (error) {
      this.logger.warn(
        `Sign-in code email failed for user ${user.id}: ${(error as Error).message}`,
      );
      // Not counted as sent (spec): put the row back as it was, so the
      // previous code — if any — keeps working.
      try {
        await this.prisma.loginVerification.updateMany({
          where: { sessionId: session.sessionId, codeHash },
          data: {
            codeHash: row.codeHash,
            codeExpiresAt: row.codeExpiresAt,
            attempts: row.attempts,
            sendCount: { decrement: 1 },
            lastSentAt: row.lastSentAt,
          },
        });
      } catch (rollbackError) {
        // The caller still needs the email-failed answer, not a bare 500. The
        // row keeps the unsent code (nobody has it) and one extra send counted.
        this.logger.error(
          `Could not un-count the failed sign-in code send for user ${user.id}: ${(rollbackError as Error).message}`,
        );
      }
      throw this.emailFailed();
    }

    return {
      verified: false,
      sentTo: maskEmail(user.email),
      resendAvailableAt: new Date(now.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS).toISOString(),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(user: AuthUser, session: AuthSession, code: string): Promise<LoginCodeVerified> {
    if (await this.gate.isVerified(session)) return { verified: true };

    const now = new Date();
    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
    });
    if (
      row === null ||
      row.userId !== user.id ||
      row.codeHash === null ||
      row.codeExpiresAt === null
    ) {
      throw this.expired();
    }
    if (row.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw this.locked();
    if (now.getTime() >= row.codeExpiresAt.getTime()) throw this.expired();

    const presented = hashLoginCode(this.pepper, session.sessionId, code);

    if (loginCodeMatches(presented, row.codeHash)) {
      const done = await this.prisma.loginVerification.updateMany({
        where: {
          sessionId: session.sessionId,
          codeHash: row.codeHash,
          verifiedAt: null,
          attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
        },
        data: {
          verifiedAt: new Date(Math.max(now.getTime(), row.createdAt.getTime())),
          codeHash: null,
          codeExpiresAt: null,
        },
      });
      if (done.count === 0) {
        // Another tab verified first (fine), other tabs' misses burned this
        // code, or a resend replaced it.
        const fresh = await this.prisma.loginVerification.findUnique({
          where: { sessionId: session.sessionId },
        });
        if (fresh === null || fresh.verifiedAt === null) {
          const burned =
            fresh !== null &&
            fresh.codeHash === row.codeHash &&
            fresh.attempts >= LOGIN_CODE_MAX_ATTEMPTS;
          throw burned ? this.locked() : this.expired();
        }
      }
      this.gate.remember(session.sessionId);
      return { verified: true };
    }

    // A miss counts only against the code it was a guess at.
    const missed = await this.prisma.loginVerification.updateMany({
      where: {
        sessionId: session.sessionId,
        codeHash: row.codeHash,
        attempts: { lt: LOGIN_CODE_MAX_ATTEMPTS },
      },
      data: { attempts: { increment: 1 } },
    });
    if (missed.count === 0) {
      const fresh = await this.prisma.loginVerification.findUnique({
        where: { sessionId: session.sessionId },
      });
      if (fresh !== null && fresh.verifiedAt !== null) {
        this.gate.remember(session.sessionId);
        return { verified: true };
      }
      // No code left at all: a resend that failed and was un-counted.
      if (fresh === null || fresh.codeHash === null) throw this.expired();
      if (fresh.attempts >= LOGIN_CODE_MAX_ATTEMPTS) throw this.locked();
      throw this.invalid(LOGIN_CODE_MAX_ATTEMPTS - fresh.attempts);
    }

    const attemptsLeft = LOGIN_CODE_MAX_ATTEMPTS - (row.attempts + 1);
    if (attemptsLeft <= 0) throw this.locked();
    throw this.invalid(attemptsLeft);
  }

  private async load(user: AuthUser, session: AuthSession): Promise<CodeRow> {
    const row = await this.prisma.loginVerification.findUnique({
      where: { sessionId: session.sessionId },
    });
    // A session id is one account's; a row naming another account is never ours.
    if (row === null || row.userId !== user.id) {
      throw new UnauthorizedException('Invalid or expired token');
    }
    return row;
  }

  /** The code already on its way, when the last send is inside the cooldown. */
  private pendingState(user: AuthUser, row: CodeRow, now: Date): LoginCodeSendResult | null {
    if (row.lastSentAt === null || row.codeExpiresAt === null) return null;
    const resendAt = row.lastSentAt.getTime() + LOGIN_CODE_RESEND_COOLDOWN_MS;
    if (now.getTime() >= resendAt) return null;
    return {
      verified: false,
      sentTo: maskEmail(user.email),
      resendAvailableAt: new Date(resendAt).toISOString(),
      expiresAt: row.codeExpiresAt.toISOString(),
    };
  }

  /**
   * Codes sent to this account in the last hour, as SUM(sendCount) over rows
   * last sent within it. Every send of a row happened at or before its
   * lastSentAt, so this can only OVERcount (refuse early), never let an
   * eleventh code through — and it needs no send log.
   */
  private async sentInLastHour(userId: string, now: Date): Promise<number> {
    const result = await this.prisma.loginVerification.aggregate({
      where: { userId, lastSentAt: { gt: new Date(now.getTime() - LOGIN_CODE_HOUR_MS) } },
      _sum: { sendCount: true },
    });
    return result._sum.sendCount ?? 0;
  }

  private sendLimit(): DomainException {
    return new DomainException(
      'LOGIN_CODE_SEND_LIMIT',
      'Too many sign-in codes have been sent. Wait a while, then sign in again.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  private emailFailed(): DomainException {
    return new DomainException(
      'LOGIN_CODE_EMAIL_FAILED',
      "We couldn't send the email. Ask the gym.",
      HttpStatus.SERVICE_UNAVAILABLE,
    );
  }

  private invalid(attemptsLeft: number): DomainException {
    return new DomainException(
      'LOGIN_CODE_INVALID',
      "That code isn't right.",
      HttpStatus.UNPROCESSABLE_ENTITY,
      { attemptsLeft },
    );
  }

  private expired(): DomainException {
    return new DomainException('LOGIN_CODE_EXPIRED', 'That code has expired. Send a new one.');
  }

  private locked(): DomainException {
    return new DomainException('LOGIN_CODE_LOCKED', 'Too many wrong tries. Send a new code.');
  }
}
