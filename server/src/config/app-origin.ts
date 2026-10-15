import { parseCorsOrigins } from './cors.options';

/** What a bare local checkout serves the client on, matching env.validation's CORS default. */
const LOCAL_SITE = 'http://localhost:3000';

/**
 * The site a link the API builds should point at — the invitation link in a
 * staff invite email, and the `redirectTo` of the account link the invite
 * page asks for.
 *
 * The request's own Origin when `CORS_ORIGIN` already trusts it (so an invite
 * issued from the local console on :3100 links back to :3100, and one issued
 * from www links to www), otherwise the FIRST trusted origin. Never an
 * arbitrary Origin header: that would let anybody who can call a public route
 * make the API hand out links to a site of their choosing.
 */
export function resolveAppOrigin(requestOrigin: string | undefined, corsOrigin: string): string {
  const trusted = parseCorsOrigins(corsOrigin);
  const asked = requestOrigin?.replace(/\/+$/, '');
  if (asked !== undefined && trusted.includes(asked)) return asked;
  return trusted[0] ?? LOCAL_SITE;
}
