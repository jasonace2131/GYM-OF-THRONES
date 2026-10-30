import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import type { ActiveSession, AuthSession } from './auth.types';

/** What the client shows the device that lost: the same words on every surface. */
export const SESSION_REPLACED_MESSAGE =
  'You were signed out because your account signed in on another device.';

export type SessionVerdict = 'allow' | 'claim' | 'reject';

/**
 * The one-device rule for one request, without the database (owner,
 * 2026-10-30: every account, one device at a time, newest sign-in wins).
 *
 * - nobody holds the account → `claim` it;
 * - this sign-in holds it → `allow`, and nothing is written;
 * - this sign-in is NEWER than the holder → `claim`: it is the new device;
 * - otherwise → `reject`: another device signed in after this one.
 *
 * A sign-in with no time (`signedInAt` null) can never take the account from
 * another device, and a holder with no time yields to any sign-in that has
 * one. Equal times do not take over: the first to claim keeps it.
 */
export function sessionVerdict(active: ActiveSession, session: AuthSession): SessionVerdict {
  if (active.sessionId === null) return 'claim';
  if (active.sessionId === session.sessionId) return 'allow';
  if (session.signedInAt === null) return 'reject';
  if (active.signedInAt === null) return 'claim';
  return session.signedInAt.getTime() > active.signedInAt.getTime() ? 'claim' : 'reject';
}

/**
 * THE ONE PLACE that enforces one device at a time.
 *
 * AuthGuard and StationTokenAccessGuard's staff path both call `assertCurrent`
 * AFTER the emailed-code gate, and AuthGuard skips it on the two
 * `/auth/login-code` routes. So only a VERIFIED sign-in ever claims the
 * account: a stolen password alone, still waiting for its code, can never
 * sign the real owner out.
 *
 * Steady state costs nothing: the holder's own requests are an `allow` read
 * from the user row provisioning already fetched. A write happens only when a
 * new device takes over, and it is CONDITIONAL on the row still being one this
 * sign-in may take, so two devices racing cannot both win. The loser re-reads
 * and is allowed only if the row now names it.
 *
 * `SINGLE_SESSION_REQUIRED=false` is the kill switch: nothing is read, written
 * or refused.
 */
@Injectable()
export class SingleSessionService {
  readonly required: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    this.required = config.get('SINGLE_SESSION_REQUIRED', { infer: true });
  }

  async assertCurrent(userId: string, active: ActiveSession, session: AuthSession): Promise<void> {
    if (!this.required) return;

    const verdict = sessionVerdict(active, session);
    if (verdict === 'allow') return;
    if (verdict === 'reject') throw replaced();

    if (await this.claim(userId, session)) return;

    // Lost a race: another request changed the holder between the read and
    // the write. Only the row as it is now can say whether that was this
    // sign-in (a second tab of the same device) or another device.
    const now = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { activeSessionId: true },
    });
    if (now?.activeSessionId === session.sessionId) return;
    throw replaced();
  }

  /** Takes the account for this sign-in, unless a newer one holds it by now. */
  private async claim(userId: string, session: AuthSession): Promise<boolean> {
    // `sessionVerdict` as a WHERE clause. An untimed sign-in takes only an
    // unclaimed account; a timed one also takes it from an older or untimed
    // holder.
    const mayTake: Prisma.UserWhereInput[] = [
      { activeSessionId: null },
      { activeSessionId: session.sessionId },
    ];
    if (session.signedInAt !== null) {
      mayTake.push(
        { activeSessionSignedInAt: null },
        { activeSessionSignedInAt: { lt: session.signedInAt } },
      );
    }
    const taken = await this.prisma.user.updateMany({
      where: { id: userId, OR: mayTake },
      data: { activeSessionId: session.sessionId, activeSessionSignedInAt: session.signedInAt },
    });
    return taken.count > 0;
  }
}

function replaced(): DomainException {
  return new DomainException('SESSION_REPLACED', SESSION_REPLACED_MESSAGE, HttpStatus.UNAUTHORIZED);
}
