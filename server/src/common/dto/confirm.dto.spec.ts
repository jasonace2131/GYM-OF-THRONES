import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../exceptions/domain.exception';
import { assertConfirmed } from './confirm.dto';

describe('assertConfirmed', () => {
  it('passes when confirm is exactly true', () => {
    expect(() => assertConfirmed({ confirm: true })).not.toThrow();
  });

  it.each([{ confirm: false }, { confirm: undefined }, {}])('throws for %p', (dto) => {
    expect(() => assertConfirmed(dto)).toThrow(DomainException);
  });

  it('throws CONFIRMATION_REQUIRED as a 400, not a validation message', () => {
    // A dangerous route that 400s with "confirm must be true" reads like a
    // client bug. CONFIRMATION_REQUIRED is a code the console can branch on to
    // re-open its own are-you-sure dialog.
    try {
      assertConfirmed({});
      throw new Error('assertConfirmed did not throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('CONFIRMATION_REQUIRED');
      expect((error as DomainException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
    }
  });
});
