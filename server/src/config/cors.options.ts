import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';

/**
 * The browser-facing half of the API contract, extracted from main.ts so the
 * header lists are unit-testable rather than only observable in a preflight.
 *
 * Four entries here are load-bearing and none is obvious from a failure:
 * - `Idempotency-Key` in allowedHeaders. The shared client wrapper sets it on
 *   every POST; an unlisted request header is silently stripped at preflight,
 *   and the symptom is a duplicate payment, not a CORS error.
 * - `Retry-After` in exposedHeaders. It is not a CORS-safelisted RESPONSE
 *   header, so without this the portal cannot read the throttler's backoff on
 *   a 429 and has nothing to wait for.
 * - `X-Station-Key` in allowedHeaders. The station display authenticates with
 *   this instead of a Bearer token (§6.2.2) and is served from a SEPARATE
 *   origin, so it goes through a real CORS preflight rather than a
 *   same-origin request the browser never questions.
 * - `If-None-Match` in allowedHeaders. Neither `Authorization` nor a custom
 *   header, it is not CORS-safelisted either, and the display's every-30-s
 *   head poll (§6.2.3) sends it to carry the cached `batchEtag`.
 */
export function buildCorsOptions(corsOrigin: string): CorsOptions {
  return {
    origin: parseCorsOrigins(corsOrigin),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Station-Key',
      'If-None-Match',
    ],
    exposedHeaders: ['Retry-After'],
  };
}

/**
 * `CORS_ORIGIN` as the list of origins it means. Shared with
 * `resolveAppOrigin` (Staff & Access), which builds invitation links only
 * against a site this list already trusts.
 */
export function parseCorsOrigins(corsOrigin: string): string[] {
  return (
    corsOrigin
      .split(',')
      .map((origin) => origin.trim())
      // TRAILING SLASHES ARE STRIPPED, and this is not tidiness.
      //
      // An HTTP Origin is scheme + host + port and NEVER carries a path — not
      // even "/". So `CORS_ORIGIN=https://www.example.com/` matches no browser
      // request ever sent, the allow-list silently contains one dead entry,
      // and every call from the site is blocked. This is exactly how
      // production broke on 2026-09-09: the preflight returned a cheerful 204
      // with allow-methods and allow-headers but NO allow-origin, so the
      // browser refused the response, the Render log recorded a successful
      // OPTIONS, and the symptom presented to the owner as "the server is
      // down" — while /api/health answered 200 the whole time.
      //
      // The env var is a URL a human pastes from a browser bar, and browsers
      // append the slash. Normalising here is cheaper than expecting nobody
      // ever to paste one.
      .map((origin) => origin.replace(/\/+$/, ''))
      .filter((origin) => origin.length > 0)
  );
}
