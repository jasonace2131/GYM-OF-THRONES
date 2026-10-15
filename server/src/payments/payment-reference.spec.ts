import { looksLikeGcashReference, normalizeGcashReference } from './payment-reference';

describe('normalizeGcashReference', () => {
  it('makes the grouped and ungrouped renderings of one reference equal', () => {
    expect(normalizeGcashReference('6028 871 884223')).toBe('6028871884223');
    expect(normalizeGcashReference('6028871884223')).toBe('6028871884223');
  });

  it('normalizes a differently-grouped reference to the same key', () => {
    // GCash groups inconsistently across screens; only the digits matter.
    expect(normalizeGcashReference('1001 543 610110')).toBe(
      normalizeGcashReference('10015 4361 0110'),
    );
  });

  it('uppercases and strips punctuation and odd whitespace', () => {
    expect(normalizeGcashReference('ftob-20190927-000141')).toBe('FTOB20190927000141');
    expect(normalizeGcashReference('gc 700123.')).toBe('GC700123');
  });
});

describe('looksLikeGcashReference', () => {
  it('accepts the usual 13-digit shape', () => {
    expect(looksLikeGcashReference('6028871884223')).toBe(true);
  });

  it('is false — a hint, never a refusal — for older and bank-funded shapes', () => {
    expect(looksLikeGcashReference('GC700123')).toBe(false);
    // 14-digit InstaPay reference from a bank-funded arrival: real money.
    expect(looksLikeGcashReference('20190927000141')).toBe(false);
  });
});
