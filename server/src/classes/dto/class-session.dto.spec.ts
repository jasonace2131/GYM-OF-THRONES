import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateClassSessionDto } from './class-session.dto';

/**
 * `POST /admin/class-sessions` at the pipe, validated exactly as main.ts's
 * global ValidationPipe does: implicit conversion on, unknown fields rejected.
 * Here for "Repeat weekly" (owner, 2026-10-30): `repeatWeeks`, 1 to 12.
 */
function constraintsOf(payload: object): Record<string, string[]> {
  const dto = plainToInstance(CreateClassSessionDto, payload, { enableImplicitConversion: true });
  return Object.fromEntries(
    validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map((error) => [
      error.property,
      Object.keys(error.constraints ?? {}),
    ]),
  );
}

const YOGA = {
  title: 'Yoga',
  coachId: '11111111-1111-4111-8111-111111111111',
  startsAt: '2026-10-29T23:00:00.000Z',
  endsAt: '2026-10-30T00:00:00.000Z',
  capacity: 16,
};

describe('CreateClassSessionDto — repeatWeeks', () => {
  it('leaves it out for a single class, as every caller before it did', () => {
    expect(constraintsOf(YOGA)).toEqual({});
  });

  it.each([1, 2, 4, 12])('accepts %p weeks', (repeatWeeks) => {
    expect(constraintsOf({ ...YOGA, repeatWeeks })).toEqual({});
  });

  it('refuses no weeks at all, and more than twelve', () => {
    expect(constraintsOf({ ...YOGA, repeatWeeks: 0 })).toEqual({ repeatWeeks: ['min'] });
    expect(constraintsOf({ ...YOGA, repeatWeeks: -1 })).toEqual({ repeatWeeks: ['min'] });
    expect(constraintsOf({ ...YOGA, repeatWeeks: 13 })).toEqual({ repeatWeeks: ['max'] });
  });

  it('refuses part of a week and a word', () => {
    expect(constraintsOf({ ...YOGA, repeatWeeks: 2.5 }).repeatWeeks).toContain('isInt');
    expect(constraintsOf({ ...YOGA, repeatWeeks: 'four' }).repeatWeeks).toContain('isInt');
  });

  it('is still strict about everything else on the body', () => {
    expect(constraintsOf({ ...YOGA, repeatWeeks: 4, repeatUntil: '2026-12-01' })).toEqual({
      repeatUntil: ['whitelistValidation'],
    });
  });
});
