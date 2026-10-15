import { describe, expect, it } from 'vitest';
import { resolveApiBase, upstreamOrigin } from './apiBase';

const PROD = 'https://api.gym-of-thrones.site/api/v1';

describe('resolveApiBase — where a request is sent from', () => {
  /**
   * THE FIX. The browser never names the API host, so it never has to reach
   * Render's shared IPs — the ones members' ISPs were blocking on 443. It
   * talks to this site's own /api/v1, and Vercel forwards it server-side.
   */
  it('sends the browser to this site’s own origin, never to the API host', () => {
    expect(resolveApiBase(PROD, true)).toBe('/api/v1');
  });

  /**
   * The landing page reads live plans in a SERVER component. A relative URL
   * is meaningless to fetch() on the server, so there it must stay absolute —
   * and Vercel's servers are not behind anybody's ISP.
   */
  it('keeps server-side code on the absolute API URL', () => {
    expect(resolveApiBase(PROD, false)).toBe(PROD);
  });

  it('derives the browser path from the configured URL rather than hard-coding it', () => {
    expect(resolveApiBase('https://example.test/api/v2', true)).toBe('/api/v2');
  });

  it('ignores a trailing slash pasted into the env var', () => {
    // The same paste that took production down via CORS_ORIGIN on 2026-09-09.
    expect(resolveApiBase(`${PROD}/`, false)).toBe(PROD);
    expect(resolveApiBase(`${PROD}/`, true)).toBe('/api/v1');
  });

  it('falls back to the local API when nothing is configured', () => {
    expect(resolveApiBase(undefined, false)).toBe('http://localhost:4000/api/v1');
    expect(resolveApiBase(undefined, true)).toBe('/api/v1');
  });
});

describe('upstreamOrigin — what the rewrite forwards to', () => {
  it('is scheme + host only, so the rewrite can append /api/:path*', () => {
    expect(upstreamOrigin(PROD)).toBe('https://api.gym-of-thrones.site');
  });

  it('keeps a non-default port, which local development relies on', () => {
    expect(upstreamOrigin('http://localhost:4000/api/v1')).toBe('http://localhost:4000');
  });

  it('falls back to the local API', () => {
    expect(upstreamOrigin(undefined)).toBe('http://localhost:4000');
  });
});
