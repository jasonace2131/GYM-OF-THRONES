import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { MarkAnnouncementsSeenDto } from './mark-announcements-seen.dto';

/**
 * Validated with the global pipe's own options — `whitelist` plus
 * `forbidNonWhitelisted` — so an extra key fails here exactly as it would 400
 * at the edge.
 */
function constraints(payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(MarkAnnouncementsSeenDto, payload, {
    enableImplicitConversion: true,
  });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('MarkAnnouncementsSeenDto', () => {
  it('accepts a full ISO-8601 instant', () => {
    expect(constraints({ upTo: '2026-09-24T03:15:00.000Z' })).toEqual([]);
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
    expect(constraints({ upTo: 1_758_000_000_000 })).toContain('isIso8601');
  });

  /**
   * The watermark is the member's own, taken from the token. A body that also
   * names a user — or anything else — is refused rather than ignored.
   */
  it('rejects an extra key', () => {
    expect(constraints({ upTo: '2026-09-24T03:15:00.000Z', userId: 'x' })).toEqual([
      'whitelistValidation',
    ]);
  });
});
