import { createHash, randomBytes } from 'node:crypto';
import type { StaffInvitationStatus } from '@got/shared';

/** Owner decision (research recommendation): a staff invitation lives a week. */
export const INVITATION_TTL_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * A fresh invitation secret and the hash that gets stored.
 *
 * 32 random bytes, base64url — 43 characters that survive a URL path and an
 * email client unescaped. Only `tokenHash` ever reaches the database; `token`
 * goes into the link and nowhere else, so a read of the table cannot be
 * turned back into a working invitation.
 */
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashInvitationToken(token) };
}

/**
 * sha256, hex. A plain hash rather than a slow password hash on purpose: the
 * input is 256 bits of randomness, not something a person chose, so there is
 * no dictionary to slow down — and the lookup must be a unique-index hit.
 */
export function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** One address, one spelling — what `StaffInvitation_email_normalised` demands. */
export function normaliseInviteEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `maria.santos@gmail.com` → `ma***@gmail.com`.
 *
 * Enough for the invitee to recognise their own address on the invite page,
 * too little for whoever else holds the link to learn it. A local part of two
 * characters or fewer keeps only one, so a two-letter address is not simply
 * printed back in full.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '***';
  const local = email.slice(0, at);
  const keep = local.length <= 2 ? 1 : 2;
  return `${local.slice(0, keep)}***${email.slice(at)}`;
}

/** When an invitation issued (or re-sent) at `now` stops working. */
export function invitationExpiry(now: Date): Date {
  return new Date(now.getTime() + INVITATION_TTL_DAYS * DAY_MS);
}

/**
 * Where an invitation stands, from its timestamps. Accepted and revoked are
 * final whatever the clock says; an open one is EXPIRED from its expiry
 * instant onwards.
 */
export function invitationStatus(
  row: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date },
  now: Date,
): StaffInvitationStatus {
  if (row.acceptedAt !== null) return 'ACCEPTED';
  if (row.revokedAt !== null) return 'REVOKED';
  return row.expiresAt.getTime() <= now.getTime() ? 'EXPIRED' : 'PENDING';
}
