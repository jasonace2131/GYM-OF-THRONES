import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * WHO an account-less guest is — a name and an email — required before a walk-in
 * or a guest pass is sold to somebody with no account (owner, 2026-10-14).
 *
 * The email is what turns a walk-in into a member later: "Make member" arrives
 * pre-filled with it, and the setup link goes there. An existing member
 * (`userId` present) is asked for neither; their account already holds both.
 *
 * Enforced HERE and not by a database CHECK: see migration
 * 20261014010100_counter_signup for why a "required" CHECK would break every
 * later update of the older guest visits that have no email.
 */
export function requireGuestIdentity(dto: {
  userId?: string;
  guestName?: string;
  guestEmail?: string;
}): void {
  if (dto.userId !== undefined) return;
  if (dto.guestName === undefined || dto.guestName === '') {
    throw new DomainException(
      'GUEST_NAME_REQUIRED',
      "Enter the guest's name before letting the guest in.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
  if (dto.guestEmail === undefined || dto.guestEmail === '') {
    throw new DomainException(
      'GUEST_EMAIL_REQUIRED',
      "Enter the guest's email before letting the guest in.",
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
