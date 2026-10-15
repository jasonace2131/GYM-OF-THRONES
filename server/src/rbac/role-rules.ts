import { HttpStatus } from '@nestjs/common';
import type { DomainErrorCode, RoleRuleRefusal } from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';

/**
 * The API's half of the role hierarchy: turn a refusal from `@got/shared`'s
 * pure rules into the exception a route throws.
 *
 * `SELF` carries the caller's own code, because every account route already
 * has one (`ROLE_SELF_CHANGE`, `MEMBER_SELF_SUSPEND`, …) and the console words
 * each refusal from it. `DEV_PROTECTED` keeps the code it has always had.
 */
export function roleRefusalException(
  refusal: RoleRuleRefusal,
  self: { code: DomainErrorCode; message: string },
): DomainException {
  switch (refusal) {
    case 'SELF':
      return new DomainException(self.code, self.message, HttpStatus.UNPROCESSABLE_ENTITY);
    case 'DEV_PROTECTED':
      return new DomainException(
        'MEMBER_DEV_PROTECTED',
        'The Super Admin account cannot be changed through this API.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    case 'TARGET_OUTRANKS':
      return new DomainException(
        'ROLE_TARGET_OUTRANKS',
        "Only the Super Admin can change an admin's account.",
        HttpStatus.FORBIDDEN,
      );
    case 'ROLE_NOT_ASSIGNABLE':
      return new DomainException(
        'ROLE_NOT_ASSIGNABLE',
        'Only the Super Admin can make somebody an admin.',
        HttpStatus.FORBIDDEN,
      );
    case 'LAST_ADMIN':
      return new DomainException(
        'LAST_ADMIN_PROTECTED',
        'This is the last active admin. Make somebody else an admin first.',
        HttpStatus.CONFLICT,
      );
  }
}
