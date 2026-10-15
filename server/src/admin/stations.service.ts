import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';
import { DomainException } from '../common/exceptions/domain.exception';
import { generateStationCode } from '../checkin/station-registry';
import type {
  AdminStation,
  AdminStationCredential,
  IssuedStationCredential,
} from './station.presenter';
import { toAdminStation, toAdminStationCredential } from './station.presenter';

/**
 * `station.manage` — the operational levers behind the check-in display.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS IS AN INCIDENT SURFACE, not a settings page.
 *
 * Three things happen here and each is something a manager does while
 * something is going wrong:
 *
 *   1. `isActive: false` — "that tablet was stolen", "that entrance is shut".
 *      It is a database write, not a redeploy, and it takes effect on the very
 *      next scan. It is also why `Station` is a table rather than an env
 *      string: with a config list the only lever is rotating the global
 *      secret, which kills every station at once.
 *   2. `bumpTokenEpoch` — the per-station panic button. Every outstanding
 *      token for THIS station dies within one slot, with no effect on any
 *      other station and no secret rotation.
 *   3. Credential issue and revoke — one tablet's access, independently of
 *      every other tablet and of every member.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE SECRET IS SHOWN EXACTLY ONCE, and only its peppered hash is stored. That
 * is not ceremony: a recoverable station key is a key that lives in a database
 * anyone with `station.manage` can read at leisure, on an account that is also
 * used for day-to-day admin. Losing it costs one revoke and one re-provision —
 * about a minute — which is a price worth paying for it never being readable
 * again.
 */
@Injectable()
export class StationsService {
  private readonly logger = new Logger(StationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Route 56. */
  async list(): Promise<AdminStation[]> {
    const rows = await this.prisma.station.findMany({
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      include: {
        credentials: { orderBy: { createdAt: 'desc' } },
        _count: { select: { checkIns: true } },
      },
    });

    return rows.map(toAdminStation);
  }

  /** Route 57. */
  async update(
    id: string,
    changes: { name?: string; isActive?: boolean; bumpTokenEpoch?: boolean },
  ): Promise<AdminStation> {
    const existing = await this.prisma.station.findUnique({ where: { id } });
    if (existing === null) {
      throw new DomainException(
        'STATION_NOT_FOUND',
        'No station has that id.',
        HttpStatus.NOT_FOUND,
      );
    }

    const row = await this.prisma.station.update({
      where: { id },
      data: {
        ...(changes.name === undefined ? {} : { name: changes.name }),
        ...(changes.isActive === undefined ? {} : { isActive: changes.isActive }),
        // INCREMENT, never assign. A settable epoch lets a typo move it
        // BACKWARDS, which silently re-validates every token minted under the
        // old value — the exact opposite of what a panic button is for.
        ...(changes.bumpTokenEpoch === true ? { tokenEpoch: { increment: 1 } } : {}),
      },
      include: {
        credentials: { orderBy: { createdAt: 'desc' } },
        _count: { select: { checkIns: true } },
      },
    });

    // Both of these are incidents. Logged loudly, with the before and after,
    // because "when did someone disable the front desk" is a question that
    // gets asked hours later by somebody who was not in the room.
    if (changes.bumpTokenEpoch === true) {
      this.logger.warn(
        `Station ${row.code} token epoch bumped ${existing.tokenEpoch} -> ${row.tokenEpoch}; ` +
          'every outstanding token for it is now invalid.',
      );
    }
    if (changes.isActive !== undefined && changes.isActive !== existing.isActive) {
      this.logger.warn(`Station ${row.code} set ${row.isActive ? 'ACTIVE' : 'INACTIVE'}.`);
    }

    return toAdminStation(row);
  }

  /**
   * Create the one station a fresh install needs.
   *
   * `code` is CSPRNG-allocated here and never afterwards: it is printed on a
   * label under the screen, so regenerating it would invalidate that label
   * without anyone touching the tablet.
   */
  async create(name: string): Promise<AdminStation> {
    const row = await this.prisma.station.create({
      data: { name, gymCode: 'GOT', code: generateStationCode() },
      include: {
        credentials: { orderBy: { createdAt: 'desc' } },
        _count: { select: { checkIns: true } },
      },
    });
    return toAdminStation(row);
  }

  /**
   * Issue a credential for one tablet. The plaintext is returned ONCE and is
   * never recoverable afterwards.
   */
  async issueCredential(
    stationId: string,
    label: string,
    createdById: string,
  ): Promise<IssuedStationCredential> {
    const station = await this.prisma.station.findUnique({ where: { id: stationId } });
    if (station === null) {
      throw new DomainException(
        'STATION_NOT_FOUND',
        'No station has that id.',
        HttpStatus.NOT_FOUND,
      );
    }

    // 32 bytes of CSPRNG, base64url. Long enough that the online guessing rate
    // this endpoint's throttle allows is irrelevant, and short enough to paste
    // onto a tablet without a typo.
    const secret = randomBytes(32).toString('base64url');
    const pepper: string = this.config.get('STATION_CREDENTIAL_PEPPER');
    const keyHash = createHash('sha256')
      .update(secret + pepper)
      .digest('hex');

    const credential = await this.prisma.stationCredential.create({
      data: { stationId, keyHash, label, createdById },
    });

    this.logger.warn(`Station credential issued for ${station.code} (${label}).`);

    return {
      credential: toAdminStationCredential(credential),
      // The ONLY time this value exists outside the tablet.
      secret,
      stationCode: station.code,
    };
  }

  /**
   * Revoke, never delete.
   *
   * `revokedAt` keeps the row, and the row is what answers "which tablet was
   * this, who provisioned it, and when did we turn it off" — the questions
   * that only get asked after something has gone wrong, which is exactly when
   * a deleted row is unrecoverable.
   *
   * Idempotent: revoking an already-revoked credential is a no-op returning
   * the same row, so a double-tap on a panicked click never 404s.
   */
  async revokeCredential(credentialId: string): Promise<AdminStationCredential> {
    const existing = await this.prisma.stationCredential.findUnique({
      where: { id: credentialId },
      include: { station: { select: { code: true } } },
    });
    if (existing === null) {
      throw new DomainException(
        'STATION_NOT_FOUND',
        'No station credential has that id.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (existing.revokedAt !== null) return toAdminStationCredential(existing);

    const row = await this.prisma.stationCredential.update({
      where: { id: credentialId },
      data: { revokedAt: new Date() },
    });

    this.logger.warn(
      `Station credential ${existing.label} revoked for station ${existing.station.code}.`,
    );

    return toAdminStationCredential(row);
  }
}
