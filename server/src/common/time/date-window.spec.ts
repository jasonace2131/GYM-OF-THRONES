import { resolveDateWindow } from './date-window';
import { DomainException } from '../exceptions/domain.exception';
import { asCivilDate } from './gym-time';

const defaults = { from: asCivilDate('2026-07-11'), to: asCivilDate('2026-11-08') };

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (caught) {
    if (caught instanceof DomainException) return caught.code;
    throw caught;
  }
  throw new Error('expected a DomainException');
}

describe('resolveDateWindow', () => {
  it('uses the defaults when nothing is sent', () => {
    expect(resolveDateWindow({}, defaults, 180)).toEqual(defaults);
  });

  it('keeps a sent window', () => {
    expect(resolveDateWindow({ from: '2026-09-01', to: '2026-09-30' }, defaults, 180)).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });

  it('refuses a reversed window', () => {
    expect(codeOf(() => resolveDateWindow({ from: '2026-09-20', to: '2026-09-01' }, defaults, 180))).toBe(
      'DATE_RANGE_INVALID',
    );
  });

  it('refuses a window wider than the cap', () => {
    expect(codeOf(() => resolveDateWindow({ from: '2026-01-01', to: '2026-12-31' }, defaults, 180))).toBe(
      'DATE_RANGE_INVALID',
    );
  });

  it('allows a window exactly at the cap', () => {
    expect(() => resolveDateWindow({ from: '2026-09-01', to: '2026-09-15' }, defaults, 14)).not.toThrow();
  });

  it('refuses a date that is not on the calendar', () => {
    expect(codeOf(() => resolveDateWindow({ from: '2026-02-31' }, defaults, 180))).toBe('DATE_RANGE_INVALID');
  });
});
