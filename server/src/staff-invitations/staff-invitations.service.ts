import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserStatus, type AuditAction } from '@prisma/client';
import {
  inviteRefusal,
  roleLabel,
  type InvitableRole,
  type InviteRefusal,
  type IssuedStaffInvitation,
  type StaffInviteAccepted,
  type StaffInviteClaim,
  type StaffInvitationLookup,
  type StaffInvitationMatch,
  type StaffInvitationView,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
import { SupabaseAdminService } from '../auth/supabase-admin.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { resolveAppOrigin } from '../config/app-origin';
import type { Env } from '../config/env.validation';
import type { AuthUser } from '../auth/auth.types';
import {
  hashInvitationToken,
  invitationExpiry,
  invitationStatus,
  maskEmail,
  newInvitationToken,
  normaliseInviteEmail,
} from './invitation-token';
import {
  STAFF_INVITATION_INCLUDE,
  toStaffInvitationView,
  type StaffInvitationRow,
} from './staff-invitation.presenter';

/** Whoever issues, re-sends or withdraws: the id to record and the role the hierarchy reads. */
export type InviteActor = Pick<AuthUser, 'id' | 'role' | 'firstName' | 'lastName'>;

/** Whoever accepts: their address must be the invited one, and their role is what changes. */
export type InviteAcceptor = Pick<AuthUser, 'id' | 'role' | 'email' | 'firstName' | 'lastName'>;

/** "Recent" on the Staff & Access list: anything issued in the last month, plus every open one. */
const RECENT_DAYS = 30;
const LIST_LIMIT = 100;
const DAY_MS = 86_400_000;

/**
 * Staff invitations — how somebody joins the gym as front desk, coach or admin.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROLE COMES FROM THE ROW, NEVER FROM THE CLIENT.
 *
 * An admin issues an invitation for one address and one role. The invitee's
 * browser only ever sends back the token; `accept` reads the role off the
 * row it finds by the token's hash. There is no request anywhere in this flow
 * that names a role the server then trusts.
 *
 * THE HIERARCHY IS CHECKED TWICE: at issue, against the inviter's role then;
 * and at acceptance, against the inviter's role NOW. An admin demoted after
 * sending an invitation cannot have it land a week later with authority they
 * no longer hold.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Every write is audited: STAFF_INVITED, STAFF_INVITE_RESENT,
 * STAFF_INVITE_REVOKED and STAFF_INVITE_ACCEPTED (which carries the
 * before/after role, because that is the moment a role changes).
 */
@Injectable()
export class StaffInvitationsService {
  private readonly logger = new Logger(StaffInvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    private readonly supabaseAdmin: SupabaseAdminService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** `GET /staff-invitations` — every open invitation, and anything from the last month. */
  async list(now: Date = new Date()): Promise<StaffInvitationView[]> {
    const rows = await this.prisma.staffInvitation.findMany({
      where: {
        OR: [
          { acceptedAt: null, revokedAt: null },
          { createdAt: { gte: new Date(now.getTime() - RECENT_DAYS * DAY_MS) } },
        ],
      },
      include: STAFF_INVITATION_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: LIST_LIMIT,
    });
    return rows.map((row) => toStaffInvitationView(row, now));
  }

  /**
   * `POST /staff-invitations`.
   *
   * Refused when the caller may not give that role (an ADMIN inviting an
   * ADMIN), when the address already holds it, or when it would demote them.
   * An open invitation for the address that is still in date is a 409 — the
   * console offers Resend for exactly that — and an EXPIRED open one is
   * superseded (marked withdrawn by this caller) in the same transaction that
   * issues its replacement, so the one-open-per-address index holds.
   */
  async create(
    actor: InviteActor,
    dto: { email: string; role: InvitableRole },
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<IssuedStaffInvitation> {
    const email = normaliseInviteEmail(dto.email);

    const existing = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { role: true },
    });
    const refusal = inviteRefusal({
      inviter: actor.role,
      role: dto.role,
      existing: existing?.role,
    });
    if (refusal !== null) throw inviteRefusalException(refusal);

    const { token, tokenHash } = newInvitationToken();

    const row = await this.prisma.$transaction(async (tx) => {
      const open = await tx.staffInvitation.findFirst({
        where: { email, acceptedAt: null, revokedAt: null },
      });
      if (open !== null) {
        if (invitationStatus(open, now) === 'PENDING') {
          throw new DomainException(
            'STAFF_INVITE_PENDING',
            'This address already has an invitation waiting. Resend that one instead.',
            HttpStatus.CONFLICT,
          );
        }
        await tx.staffInvitation.update({
          where: { id: open.id },
          data: { revokedAt: now, revokedById: actor.id },
        });
      }

      return tx.staffInvitation.create({
        data: {
          email,
          role: dto.role,
          tokenHash,
          invitedById: actor.id,
          // Explicit, not the column default: `expiresAt > createdAt` is a
          // CHECK, and both must come from the same clock.
          createdAt: now,
          expiresAt: invitationExpiry(now),
        },
        include: STAFF_INVITATION_INCLUDE,
      });
    });

    await this.record('STAFF_INVITED', actor, row, now);
    return this.issue(actor, row, token, requestOrigin, now);
  }

  /**
   * `POST /staff-invitations/:id/resend` — a NEW token and a fresh seven
   * days. The old link stops working the moment this commits, which is the
   * point: "resend" after a link was forwarded to the wrong person must not
   * leave the forwarded one alive. Works on an expired invitation too; that is
   * the usual reason to resend.
   */
  async resend(
    actor: InviteActor,
    id: string,
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<IssuedStaffInvitation> {
    const before = await this.openInvitation(id);
    this.assertMayManage(actor, before);

    const { token, tokenHash } = newInvitationToken();
    const { count } = await this.prisma.staffInvitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { tokenHash, expiresAt: invitationExpiry(now) },
    });
    if (count === 0) await this.openInvitation(id); // throws USED / REVOKED: it moved under us

    const row = await this.requireInvitation(id);
    await this.record('STAFF_INVITE_RESENT', actor, row, now);
    return this.issue(actor, row, token, requestOrigin, now);
  }

  /** `POST /staff-invitations/:id/revoke`. Open invitations only, in date or not. */
  async revoke(
    actor: InviteActor,
    id: string,
    now: Date = new Date(),
  ): Promise<StaffInvitationView> {
    const before = await this.openInvitation(id);
    this.assertMayManage(actor, before);

    const { count } = await this.prisma.staffInvitation.updateMany({
      where: { id, acceptedAt: null, revokedAt: null },
      data: { revokedAt: now, revokedById: actor.id },
    });
    if (count === 0) await this.openInvitation(id);

    const row = await this.requireInvitation(id);
    await this.record('STAFF_INVITE_REVOKED', actor, row, now);
    return toStaffInvitationView(row, now);
  }

  /**
   * `GET /staff-invitations/lookup?token=` — PUBLIC. The role and a masked
   * address, nothing else. A dead link answers 410 with the reason, because
   * "this invitation was withdrawn" and "this link expired" send the invitee
   * to different people.
   */
  async lookup(token: string, now: Date = new Date()): Promise<StaffInvitationLookup> {
    const row = await this.usableInvitation(token, now);
    return { role: row.role as InvitableRole, maskedEmail: maskEmail(row.email) };
  }

  /**
   * `GET /staff-invitations/match?token=` — signed in. Whether the caller's
   * address is the invited one, compared exactly as `accept` compares it. A
   * dead or unknown link answers with the same errors as `lookup`, so this
   * route tells nobody anything the public lookup does not.
   */
  async match(
    caller: Pick<AuthUser, 'email'>,
    token: string,
    now: Date = new Date(),
  ): Promise<StaffInvitationMatch> {
    const row = await this.usableInvitation(token, now);
    return { matches: normaliseInviteEmail(caller.email) === row.email };
  }

  /**
   * `POST /staff-invitations/claim-link` — PUBLIC. "Set up my account".
   *
   * For an address Supabase has never seen: a link that creates the account
   * and returns the browser to this invitation, signed in. For an address
   * that already has an account: `SIGN_IN` and no link (see
   * `SupabaseAdminService.staffInviteAccountLink` for why). Never applies the
   * role — only `accept`, by the signed-in owner of the address, does that.
   */
  async claimLink(
    token: string,
    requestOrigin: string | undefined,
    now: Date = new Date(),
  ): Promise<StaffInviteClaim> {
    const row = await this.usableInvitation(token, now);
    const redirectTo = `${this.appOrigin(requestOrigin)}/invite/${token}`;
    const result = await this.supabaseAdmin.staffInviteAccountLink(row.email, redirectTo);
    return result.kind === 'NEW_ACCOUNT'
      ? { kind: 'REDIRECT', url: result.actionLink }
      : { kind: 'SIGN_IN' };
  }

  /**
   * `POST /staff-invitations/accept` — the signed-in owner of the invited
   * address takes it up.
   *
   * The local `User` row always exists by now: `AuthGuard` provisions it on
   * the caller's first authenticated request, which is this one at the latest.
   *
   * Order matters. Everything that can refuse runs before anything writes;
   * then one transaction claims the invitation (a conditional update, so a
   * double-click or a race claims it once) and sets the role.
   */
  async accept(
    caller: InviteAcceptor,
    token: string,
    now: Date = new Date(),
  ): Promise<StaffInviteAccepted> {
    const row = await this.findByToken(token);

    // A double-click, or a reload after success: done, not an error.
    if (row.acceptedAt !== null && row.acceptedById === caller.id) {
      return { role: row.role, changed: false };
    }
    assertUsable(row, now);

    if (normaliseInviteEmail(caller.email) !== row.email) {
      throw new DomainException(
        'STAFF_INVITE_EMAIL_MISMATCH',
        'This invitation was sent to a different email address. Sign in with that address to accept it.',
        HttpStatus.FORBIDDEN,
      );
    }

    // The inviter's authority is checked as it stands NOW, not as it stood
    // when they pressed Invite.
    const inviter = await this.prisma.user.findUnique({
      where: { id: row.invitedById },
      select: { role: true, status: true, deletedAt: true },
    });
    if (inviter === null || inviter.deletedAt !== null || inviter.status !== UserStatus.ACTIVE) {
      throw revoked(
        'The person who invited you no longer has an active account. Ask for a new invitation.',
      );
    }

    const refusal = inviteRefusal({ inviter: inviter.role, role: row.role, existing: caller.role });
    if (refusal === 'ROLE_NOT_INVITABLE') {
      throw new DomainException(
        'ROLE_NOT_ASSIGNABLE',
        'The person who invited you can no longer give this role. Ask for a new invitation.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (refusal === 'WOULD_DEMOTE') throw inviteRefusalException(refusal);
    const changed = refusal !== 'ALREADY_HAS_ROLE';

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.staffInvitation.updateMany({
        where: { id: row.id, acceptedAt: null, revokedAt: null },
        data: { acceptedAt: now, acceptedById: caller.id },
      });
      if (count === 0) throw used();
      if (changed) {
        await tx.user.update({ where: { id: caller.id }, data: { role: row.role } });
      }
    });

    await this.audit.record(
      {
        action: 'STAFF_INVITE_ACCEPTED',
        actorId: caller.id,
        // Snapshotted BEFORE the change, like every actorRole: what they were
        // when they did it.
        actorRole: caller.role,
        subjectType: 'User',
        subjectId: caller.id,
        subjectLabel: `${caller.firstName} ${caller.lastName}`.trim(),
        details: { role: { before: caller.role, after: row.role }, invitationId: row.id },
      },
      now,
    );

    return { role: row.role, changed };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** The one audit shape for the three admin-side actions. */
  private async record(
    action: Extract<AuditAction, 'STAFF_INVITED' | 'STAFF_INVITE_RESENT' | 'STAFF_INVITE_REVOKED'>,
    actor: InviteActor,
    row: StaffInvitationRow,
    now: Date,
  ): Promise<void> {
    await this.audit.record(
      {
        action,
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'StaffInvitation',
        subjectId: row.id,
        subjectLabel: row.email,
        details: { role: row.role },
      },
      now,
    );
  }

  /** Email the link, and hand it back once whether or not the email went. */
  private async issue(
    actor: InviteActor,
    row: StaffInvitationRow,
    token: string,
    requestOrigin: string | undefined,
    now: Date,
  ): Promise<IssuedStaffInvitation> {
    const link = `${this.appOrigin(requestOrigin)}/invite/${token}`;

    let emailSent = false;
    try {
      await this.email.sendStaffInvite(row.email, {
        roleLabel: roleLabel(row.role),
        inviterName: `${actor.firstName} ${actor.lastName}`.trim(),
        link,
      });
      emailSent = true;
    } catch (err) {
      // The invitation is committed; the console shows the link to copy.
      this.logger.warn(`Staff invite email failed for invitation ${row.id}: ${String(err)}`);
    }

    return { invitation: toStaffInvitationView(row, now), link, emailSent };
  }

  private appOrigin(requestOrigin: string | undefined): string {
    return resolveAppOrigin(requestOrigin, this.config.get('CORS_ORIGIN', { infer: true }));
  }

  /**
   * Resend and revoke act on any OPEN invitation (in date or expired) whose
   * role the caller could give. An ADMIN cannot resend or withdraw the Super
   * Admin's invitation of another ADMIN.
   */
  private assertMayManage(actor: InviteActor, row: StaffInvitationRow): void {
    if (inviteRefusal({ inviter: actor.role, role: row.role }) !== null) {
      throw inviteRefusalException('ROLE_NOT_INVITABLE');
    }
  }

  private async requireInvitation(id: string): Promise<StaffInvitationRow> {
    const row = await this.prisma.staffInvitation.findUnique({
      where: { id },
      include: STAFF_INVITATION_INCLUDE,
    });
    if (row === null) throw notFound();
    return row;
  }

  /** Neither accepted nor withdrawn. Expired is fine here — see `resend`. */
  private async openInvitation(id: string): Promise<StaffInvitationRow> {
    const row = await this.requireInvitation(id);
    if (row.acceptedAt !== null) throw used();
    if (row.revokedAt !== null) throw revoked();
    return row;
  }

  private async findByToken(token: string): Promise<StaffInvitationRow> {
    const row = await this.prisma.staffInvitation.findUnique({
      where: { tokenHash: hashInvitationToken(token) },
      include: STAFF_INVITATION_INCLUDE,
    });
    if (row === null) throw notFound();
    return row;
  }

  private async usableInvitation(token: string, now: Date): Promise<StaffInvitationRow> {
    const row = await this.findByToken(token);
    assertUsable(row, now);
    return row;
  }
}

function assertUsable(row: StaffInvitationRow, now: Date): void {
  switch (invitationStatus(row, now)) {
    case 'ACCEPTED':
      throw used();
    case 'REVOKED':
      throw revoked();
    case 'EXPIRED':
      throw new DomainException(
        'STAFF_INVITE_EXPIRED',
        'This invitation has expired. Ask the person who sent it to resend it.',
        HttpStatus.GONE,
      );
    case 'PENDING':
      return;
  }
}

function notFound(): DomainException {
  return new DomainException(
    'STAFF_INVITE_NOT_FOUND',
    'This invitation link is not valid. Check you copied all of it.',
    HttpStatus.NOT_FOUND,
  );
}

function used(): DomainException {
  return new DomainException(
    'STAFF_INVITE_USED',
    'This invitation has already been used.',
    HttpStatus.GONE,
  );
}

function revoked(
  message = 'This invitation was withdrawn. Ask the gym for a new one if you still need it.',
): DomainException {
  return new DomainException('STAFF_INVITE_REVOKED', message, HttpStatus.GONE);
}

function inviteRefusalException(refusal: InviteRefusal): DomainException {
  switch (refusal) {
    case 'ROLE_NOT_INVITABLE':
      return new DomainException(
        'ROLE_NOT_ASSIGNABLE',
        'You can only invite roles below your own. Only the Super Admin invites admins.',
        HttpStatus.FORBIDDEN,
      );
    case 'ALREADY_HAS_ROLE':
      return new DomainException(
        'STAFF_INVITE_ALREADY_HAS_ROLE',
        'That account already has this role.',
        HttpStatus.CONFLICT,
      );
    case 'WOULD_DEMOTE':
      return new DomainException(
        'STAFF_INVITE_WOULD_DEMOTE',
        'That account already has a higher role. Change roles from Staff & Access instead.',
        HttpStatus.CONFLICT,
      );
  }
}
