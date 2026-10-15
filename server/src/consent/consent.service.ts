import { Injectable, Logger } from '@nestjs/common';
import { ConsentKind, type Prisma } from '@prisma/client';
import { LEGAL_VERSIONS, REQUIRED_CONSENTS, type LegalDocumentKind } from '@got/shared';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { hashIp } from '../checkin/origin';
import type { Env } from '../config/env.validation';

/** A user agent longer than this is a bot or a bug, not a browser. */
const USER_AGENT_MAX = 400;

export interface ConsentStanding {
  /** Documents this caller has accepted at the CURRENT version. */
  accepted: LegalDocumentKind[];
  /** Documents they must accept before the portal opens. */
  outstanding: LegalDocumentKind[];
  /** Convenience for the gate: nothing outstanding. */
  satisfied: boolean;
}

/**
 * Who agreed to what, and when.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONLY WRITER IS AN INSERT. There is no update and no delete here, and
 * that is deliberate rather than incidental: the value of this table is that
 * it can answer "which wording did this member accept in March", and an
 * UPDATE erases exactly that. Re-acceptance after a version bump is a NEW row.
 *
 * A member's erasure request under RA 10173 §16(e) removes the rows by
 * cascade from `User` — which is why the FK is CASCADE where everything else
 * in this schema is RESTRICT. Evidence *about* a person must not be the thing
 * that prevents deleting them.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  private readonly ipPepper: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
  ) {
    // Read once at construction, matching CheckInService — the pepper is
    // boot-time configuration, not per-request state.
    this.ipPepper = config.get('IP_HASH_PEPPER', { infer: true });
  }

  /**
   * What this caller still owes.
   *
   * Compares against `LEGAL_VERSIONS` rather than "has any row", so bumping a
   * version re-prompts everybody with no migration and no sweep job.
   */
  async standing(userId: string): Promise<ConsentStanding> {
    const rows = await this.prisma.consentRecord.findMany({
      where: { userId },
      select: { kind: true, version: true },
    });

    const current = new Set(
      rows
        .filter((row) => LEGAL_VERSIONS[row.kind as LegalDocumentKind] === row.version)
        .map((row) => row.kind as LegalDocumentKind),
    );

    const accepted = REQUIRED_CONSENTS.filter((kind) => current.has(kind));
    const outstanding = REQUIRED_CONSENTS.filter((kind) => !current.has(kind));

    return { accepted, outstanding, satisfied: outstanding.length === 0 };
  }

  /**
   * Record acceptance of one or more documents.
   *
   * `skipDuplicates` rather than a pre-check: the unique index is
   * `(userId, kind, version)`, so a double-submit, a refresh, or two tabs
   * racing all settle on one row without a transaction. Accepting a version
   * twice is not an error worth reporting to a member.
   *
   * The version is taken from `LEGAL_VERSIONS`, NEVER from the request. A
   * client that could name its own version could claim acceptance of wording
   * that was never shown — which is the one thing this record exists to
   * disprove.
   */
  async accept(
    userId: string,
    kinds: readonly LegalDocumentKind[],
    context: { ip?: string | undefined; userAgent?: string | undefined },
    now: Date = new Date(),
  ): Promise<ConsentStanding> {
    const data: Prisma.ConsentRecordCreateManyInput[] = kinds.map((kind) => ({
      userId,
      kind: ConsentKind[kind],
      version: LEGAL_VERSIONS[kind],
      acceptedAt: now,
      // Peppered hash, never the address — the same control StationScan uses.
      // Evidencing consent must not itself create a privacy problem.
      ipHash: context.ip === undefined ? null : hashIp(context.ip, this.ipPepper),
      userAgent: context.userAgent?.slice(0, USER_AGENT_MAX) ?? null,
    }));

    const { count } = await this.prisma.consentRecord.createMany({ data, skipDuplicates: true });

    if (count > 0) {
      this.logger.log(
        `consent recorded user=${userId} kinds=${kinds.join(',')} rows=${count}`,
      );
    }

    return this.standing(userId);
  }
}
