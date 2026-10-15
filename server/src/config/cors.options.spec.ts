import { buildCorsOptions } from './cors.options';

describe('buildCorsOptions', () => {
  it('splits CORS_ORIGIN on commas and trims each origin', () => {
    const options = buildCorsOptions('http://localhost:3000, https://gymofthrones.ph ');
    expect(options.origin).toEqual(['http://localhost:3000', 'https://gymofthrones.ph']);
  });

  it('drops empty segments from a trailing comma', () => {
    expect(buildCorsOptions('http://localhost:3000,').origin).toEqual(['http://localhost:3000']);
  });

  /**
   * THE ONE THAT TOOK PRODUCTION DOWN (2026-09-09).
   *
   * CORS_ORIGIN was pasted from a browser bar as
   * `https://www.gym-of-thrones.site/`. An Origin header never carries a
   * path, so the allow-list held one entry that could not match any real
   * request: every call from the site was blocked, while /api/health kept
   * answering 200 and the preflight kept returning 204 — with no
   * Access-Control-Allow-Origin on it. It presented as "the server is down".
   */
  it('strips a trailing slash, because no browser ever sends one', () => {
    expect(buildCorsOptions('https://www.gym-of-thrones.site/').origin).toEqual([
      'https://www.gym-of-thrones.site',
    ]);
  });

  it('strips trailing slashes across a comma-separated list', () => {
    expect(
      buildCorsOptions('https://gym-of-thrones.site/, https://www.gym-of-thrones.site/').origin,
    ).toEqual(['https://gym-of-thrones.site', 'https://www.gym-of-thrones.site']);
  });

  it('leaves a bare origin untouched', () => {
    expect(buildCorsOptions('https://gym-of-thrones.site').origin).toEqual([
      'https://gym-of-thrones.site',
    ]);
  });

  it('does not turn a slash-only segment into an empty allow-list entry', () => {
    // '/' normalises to '' and must be dropped, not kept as a wildcard-ish
    // empty string the cors package would treat as a value.
    expect(buildCorsOptions('http://localhost:3000, /').origin).toEqual(['http://localhost:3000']);
  });

  it('allows the Idempotency-Key request header', () => {
    // Without this the browser strips the header at preflight and the symptom
    // presents as duplicate charges rather than as a CORS problem.
    expect(options().allowedHeaders).toContain('Idempotency-Key');
  });

  it('still allows Content-Type and Authorization', () => {
    expect(options().allowedHeaders).toEqual(
      expect.arrayContaining(['Content-Type', 'Authorization']),
    );
  });

  it('exposes Retry-After so the browser can read a 429 backoff', () => {
    expect(options().exposedHeaders).toContain('Retry-After');
  });

  it('lists PUT among the allowed methods', () => {
    // For the already-approved RBAC phase-4 routes. No chunk 0-2 endpoint uses it.
    expect(options().methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
  });

  it('keeps credentials enabled', () => {
    expect(options().credentials).toBe(true);
  });
});

function options(): ReturnType<typeof buildCorsOptions> {
  return buildCorsOptions('http://localhost:3000');
}
