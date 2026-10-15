import { HttpStatus } from '@nestjs/common';
import { IsBoolean, IsOptional } from 'class-validator';
import { DomainException } from '../exceptions/domain.exception';

/**
 * The `confirm: true` mixin every dangerous route reuses.
 *
 * Deliberately NOT `@Equals(true)`: that makes a missing confirmation a
 * ValidationPipe 400 carrying "confirm must be equal to true", which reads like
 * a client bug and gives the console nothing to branch on. The property is
 * optional to the pipe and mandatory to the service, so the refusal is a
 * CONFIRMATION_REQUIRED code the are-you-sure dialog can re-open on.
 *
 * The declared type is `true` rather than `boolean | undefined` because that is
 * the only value a request which has passed assertConfirmed can carry. The gap
 * between the type and the wire is exactly one call, at the top of the handler.
 */
export abstract class ConfirmDto {
  @IsOptional()
  @IsBoolean()
  confirm!: true;
}

/** Throws CONFIRMATION_REQUIRED (400) unless `confirm` is exactly `true`. */
export function assertConfirmed(dto: { confirm?: boolean }): void {
  if (dto.confirm !== true) {
    throw new DomainException(
      'CONFIRMATION_REQUIRED',
      'This action is irreversible and requires "confirm": true.',
      HttpStatus.BAD_REQUEST,
    );
  }
}
