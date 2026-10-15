import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SuspendMemberDto } from './suspend-member.dto';

function parse(payload: Record<string, unknown>): {
  dto: SuspendMemberDto;
  constraints: string[];
} {
  const dto = plainToInstance(SuspendMemberDto, payload, { enableImplicitConversion: true });
  const constraints = validateSync(dto).flatMap((error) => Object.keys(error.constraints ?? {}));
  return { dto, constraints };
}

/**
 * The `@Transform` trim is the whole point of this file: `@Length(3, 200)`
 * counts characters, and three spaces are three characters. Without the trim
 * running FIRST, `"   "` is a valid suspension reason that lands in the audit
 * trail blank — the operator sees a suspension with no stated cause and no way
 * to tell it apart from a real one.
 */
describe('SuspendMemberDto', () => {
  it('accepts a real reason', () => {
    expect(parse({ reason: 'Chargeback dispute' }).constraints).toEqual([]);
  });

  it('rejects a whitespace-only reason — the trim runs before the length check', () => {
    expect(parse({ reason: '   ' }).constraints).toEqual(['isLength']);
  });

  it('rejects a reason that is only whitespace around too-short text', () => {
    expect(parse({ reason: '  ab  ' }).constraints).toEqual(['isLength']);
  });

  it('stores the trimmed value, not the padded one', () => {
    expect(parse({ reason: '  Chargeback dispute  ' }).dto.reason).toBe('Chargeback dispute');
  });

  it('still enforces the 200-character ceiling', () => {
    expect(parse({ reason: 'a'.repeat(201) }).constraints).toEqual(['isLength']);
  });

  it('lets a non-string reason through the transform untouched, then fails validation', () => {
    // The transform is `typeof value === 'string' ? trim : value` — it must
    // never call `.trim()` on a non-string and 500 the route. Under the app's
    // `enableImplicitConversion`, 42 arrives as the string "42" and is caught
    // by the length rule rather than the type rule; either way it is rejected,
    // and nothing threw on the way there.
    expect(parse({ reason: 42 }).constraints).toEqual(['isLength']);
    expect(parse({ reason: null }).constraints).toContain('isString');
  });
});
