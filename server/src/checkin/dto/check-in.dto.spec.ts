import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CheckInDto } from './check-in.dto';

/** §6.1.1's canonical example payload — 36 characters, four-character station code. */
const CANONICAL = 'GOTS1.9F2K.59570000.4RTXK8B2QWY5H3PZ';

function parse(payload: unknown): { dto: CheckInDto; constraints: string[] } {
  const dto = plainToInstance(
    CheckInDto,
    { stationToken: payload },
    { enableImplicitConversion: true },
  );
  const constraints = validateSync(dto).flatMap((error) => Object.keys(error.constraints ?? {}));
  return { dto, constraints };
}

describe('CheckInDto', () => {
  it("accepts §6.1.1's canonical payload", () => {
    expect(parse(CANONICAL).constraints).toEqual([]);
  });

  it('accepts a nine-digit slot', () => {
    expect(parse('GOTS1.9F2K.595700001.4RTXK8B2QWY5H3PZ').constraints).toEqual([]);
  });

  it('trims the newline a keyboard-wedge scanner appends', () => {
    const { dto, constraints } = parse(`  ${CANONICAL}\n`);
    expect(constraints).toEqual([]);
    expect(dto.stationToken).toBe(CANONICAL);
  });

  it('uppercases what a lowercase in-browser decoder emits', () => {
    const { dto, constraints } = parse(CANONICAL.toLowerCase());
    expect(constraints).toEqual([]);
    expect(dto.stationToken).toBe(CANONICAL);
  });

  it('rejects a foreign QR', () => {
    expect(parse('https://example.com/menu').constraints.length).toBeGreaterThan(0);
  });

  it('rejects a five-character station code at the same overall length', () => {
    // The regression: length alone cannot tell these apart, so the regex has
    // to. 36 characters either way.
    const fiveCharCode = 'GOTS1.9F2KX.5957000.4RTXK8B2QWY5H3PZ';
    expect(fiveCharCode).toHaveLength(CANONICAL.length);
    expect(parse(fiveCharCode).constraints).toEqual(['matches']);
  });

  it('rejects a station code containing an excluded character', () => {
    // I, L, O and U are not in the Crockford alphabet.
    expect(parse('GOTS1.9F2I.59570000.4RTXK8B2QWY5H3PZ').constraints).toEqual(['matches']);
  });

  it('rejects a v1 member badge payload', () => {
    expect(parse('GOT1.9F2K.59570000.4RTXK8B2QWY5H3PZ').constraints.length).toBeGreaterThan(0);
  });

  it('rejects a non-string payload', () => {
    expect(parse(12345).constraints.length).toBeGreaterThan(0);
  });
});
