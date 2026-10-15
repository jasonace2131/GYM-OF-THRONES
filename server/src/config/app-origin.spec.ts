import { resolveAppOrigin } from './app-origin';

/**
 * Where a link the API emails or hands back should point: the site the
 * request came from, IF that site is one the API already trusts (CORS_ORIGIN),
 * else the first trusted one. Never an arbitrary Origin header — that would
 * let anybody make the API mail out a link to a site of their choosing.
 */
describe('resolveAppOrigin', () => {
  const cors = 'https://gym-of-thrones.site, https://www.gym-of-thrones.site/';

  it('uses the request origin when CORS already trusts it', () => {
    expect(resolveAppOrigin('https://www.gym-of-thrones.site', cors)).toBe(
      'https://www.gym-of-thrones.site',
    );
  });

  it('falls back to the first trusted origin for an untrusted or absent one', () => {
    expect(resolveAppOrigin('https://evil.example', cors)).toBe('https://gym-of-thrones.site');
    expect(resolveAppOrigin(undefined, cors)).toBe('https://gym-of-thrones.site');
  });

  it('strips a pasted trailing slash, like the CORS allow-list does', () => {
    expect(resolveAppOrigin(undefined, 'http://localhost:3100/')).toBe('http://localhost:3100');
  });

  it('falls back to the local dev site when nothing is configured', () => {
    expect(resolveAppOrigin(undefined, '')).toBe('http://localhost:3000');
  });
});
