import { HttpStatus } from '@nestjs/common';
import { MINIMUM_AGE_MESSAGE, meetsMinimumAge } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import { latestToday } from '../common/validators/is-birth-date.validator';

/**
 * The minimum account age as the API applies it (owner, 2026-10-30: nobody
 * under 12 has an account; this reverses 2026-10-23's "no minimum age").
 *
 * Checked only where a date of birth first reaches an account: a self sign-up
 * on first sight (`UserProvisioningService`, 403), the counter's create
 * (`MembersService.create`, 400) and the setup link (`MemberJoinService.accept`,
 * 400). An account already on file is never re-checked, whatever its date says.
 *
 * "Today" is `latestToday` (UTC+14), like `IsBirthDate`: a 12th birthday that
 * has begun anywhere counts, so a page checking against the gym's own today
 * can never pass a date the API then refuses.
 */
export function isOldEnoughForAccount(dateOfBirth: string, now: number = Date.now()): boolean {
  return meetsMinimumAge(dateOfBirth, latestToday(now));
}

export function ageRequirementNotMet(status: HttpStatus): DomainException {
  return new DomainException('AGE_REQUIREMENT_NOT_MET', MINIMUM_AGE_MESSAGE, status);
}

/**
 * The one provisioning failure AuthGuard and the station guard let through
 * their generic 401: it is not a token problem, and the sign-in page must be
 * able to say why rather than ask for a sign-in that can never work.
 */
export function isAgeRequirementRefusal(error: unknown): error is DomainException {
  return error instanceof DomainException && error.code === 'AGE_REQUIREMENT_NOT_MET';
}
