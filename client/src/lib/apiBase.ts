/**
 * Where API requests go — the one place that decides it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE BROWSER NEVER TALKS TO THE API HOST DIRECTLY.
 *
 * It calls this site's own `/api/v1/...`, and `next.config.ts` rewrites that
 * to Render server-side. Two outages drove this:
 *
 *   ISP BLOCKS. Render's free tier puts custom domains on shared anycast IPs,
 *   and at least one Philippine ISP refuses TCP 443 to 216.24.57.16 and .18 —
 *   collateral from some other tenant on the same address. Both
 *   api.gym-of-thrones.site and got-api.onrender.com resolve there. The owner
 *   could only sign in with Cloudflare WARP running, and every member on the
 *   same ISP would have hit "Failed to fetch" with no way round it. Vercel's
 *   servers are not behind that ISP; members' browsers only ever reach
 *   Vercel.
 *
 *   CORS. With the browser and the API on one origin there is no cross-origin
 *   request left to refuse. CORS_ORIGIN misconfiguration took the site down
 *   on 2026-09-09 (a trailing slash) and 2026-09-21 (the apex host missing),
 *   both times while /api/health answered 200.
 *
 * SERVER-SIDE CODE STAYS ABSOLUTE. The landing page fetches live plans in a
 * server component, and `fetch('/api/v1/plans')` has no host to resolve on
 * the server. Vercel's servers call Render directly, which is exactly what
 * the rewrite does too.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const LOCAL_API = 'http://localhost:4000/api/v1';

function configured(raw: string | undefined): string {
  return (raw ?? LOCAL_API).replace(/\/+$/, '');
}

/** The base URL for a request made from the browser (`true`) or the server. */
export function resolveApiBase(raw: string | undefined, isBrowser: boolean): string {
  const absolute = configured(raw);
  return isBrowser ? new URL(absolute).pathname : absolute;
}

/** Scheme + host (+ port) of the real API — what the rewrite forwards to. */
export function upstreamOrigin(raw: string | undefined): string {
  return new URL(configured(raw)).origin;
}

/*
 * `process.env.NEXT_PUBLIC_API_URL` must be written out literally: Next only
 * inlines a NEXT_PUBLIC_ variable into the browser bundle where the full
 * expression appears in source. Reading it through a helper would leave the
 * browser with `undefined` and silently fall back to localhost.
 */
export const API_URL = resolveApiBase(
  process.env.NEXT_PUBLIC_API_URL,
  typeof window !== 'undefined',
);
