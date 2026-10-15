import { canonicalise, hashRequestBody } from './request-hash';

/**
 * Storing the request hash is what stops a replay with a DIFFERENT body
 * returning the first request's receipt with a 200 — which would manufacture a
 * plausible-looking success, worse than no idempotency at all.
 */
describe('canonicalise', () => {
  it('is insensitive to key order', () => {
    expect(canonicalise({ b: 2, a: 1 })).toBe(canonicalise({ a: 1, b: 2 }));
  });

  it('sorts nested keys too', () => {
    expect(canonicalise({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('preserves array order — [1,2] is not [2,1]', () => {
    expect(canonicalise({ items: [1, 2] })).not.toBe(canonicalise({ items: [2, 1] }));
  });

  it('renders undefined as null rather than throwing', () => {
    expect(canonicalise(undefined)).toBe('null');
  });
});

describe('hashRequestBody', () => {
  it('is a 64-character sha256 hex digest', () => {
    expect(hashRequestBody({ netCentavos: 80000 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores key order and whitespace', () => {
    expect(hashRequestBody({ b: 2, a: 1 })).toBe(
      hashRequestBody(JSON.parse('{ "a": 1,\n"b": 2 }')),
    );
  });

  it('changes when a value changes', () => {
    expect(hashRequestBody({ netCentavos: 80000 })).not.toBe(
      hashRequestBody({ netCentavos: 80001 }),
    );
  });

  it('treats a missing body and an empty body identically', () => {
    expect(hashRequestBody(undefined)).toBe(hashRequestBody({}));
  });
});
