import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MarkNoticesSeenDto } from './mark-notices-seen.dto';

/**
 * Validated with the global pipe's own options — `whitelist` plus
 * `forbidNonWhitelisted` — so an extra key fails here exactly as it would 400
 * at the edge.
 */
function constraints(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(MarkNoticesSeenDto, payload, {
    enableImplicitConversion: true,
  });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('MarkNoticesSeenDto', () => {
  it('accepts a full ISO-8601 instant', () => {
    expect(constraints({ upTo: '2026-10-11T03:15:00.000Z' })).toEqual([]);
  });

  it('accepts an instant written with an offset', () => {
    expect(constraints({ upTo: '2026-10-11T11:15:00.000+08:00' })).toEqual([]);
  });

  it('rejects a missing upTo', () => {
    expect(constraints({})).toContain('isIso8601');
  });

  it('rejects a string that is not a date', () => {
    expect(constraints({ upTo: 'yesterday' })).toContain('isIso8601');
  });

  /** strict: a date that does not exist on the calendar is not an instant. */
  it('rejects an impossible calendar date', () => {
    expect(constraints({ upTo: '2026-02-30T00:00:00.000Z' })).toContain('isIso8601');
  });

  it('rejects a number', () => {
    expect(constraints({ upTo: 1_760_000_000_000 })).toContain('isIso8601');
  });

  /**
   * ISO 8601 that `new Date()` cannot read. Each passes `@IsISO8601` and would
   * otherwise reach the query as an Invalid Date — a 500, not a 400.
   */
  it.each([
    ['a week date', '2026-W41'],
    ['an ordinal date', '2026-284'],
    ['the basic format', '20261011T031500Z'],
    ['a comma fraction', '2026-10-11T03:15:00,5Z'],
    ['a bare day, which has no time', '2026-10-11'],
  ])('rejects %s', (_label, upTo) => {
    expect(constraints({ upTo })).toEqual(['matches']);
  });

  /**
   * The notices are the member's own, taken from the token. A body that also
   * names a user — or anything else — is refused rather than ignored.
   */
  it('rejects an extra key', () => {
    expect(constraints({ upTo: '2026-10-11T03:15:00.000Z', userId: 'x' })).toEqual([
      'whitelistValidation',
    ]);
  });
});
