import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CheckOutDto } from './check-out.dto';

function constraintsOf(body: Record<string, unknown>): string[] {
  const dto = plainToInstance(CheckOutDto, body);
  return validateSync(dto).flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('CheckOutDto', () => {
  it('accepts a visit id', () => {
    expect(constraintsOf({ checkInId: 'c0000000-0000-4000-8000-000000000001' })).toEqual([]);
  });

  it('refuses a missing or non-uuid id', () => {
    expect(constraintsOf({})).toContain('isUuid');
    expect(constraintsOf({ checkInId: 'not-a-uuid' })).toContain('isUuid');
  });
});
