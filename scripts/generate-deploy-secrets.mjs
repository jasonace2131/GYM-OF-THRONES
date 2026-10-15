#!/usr/bin/env node
/**
 * Generates the three production secrets this API needs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * RUN THIS YOURSELF, AND PASTE THE OUTPUT STRAIGHT INTO RAILWAY.
 *
 * It is a script rather than three values in a chat message or a committed
 * file on purpose: a secret that passes through a transcript, a ticket or a
 * git object is a secret that now lives in a place nobody will remember to
 * clean. Generating them on the machine that will paste them means they exist
 * in exactly one place before Railway, and that place is your clipboard.
 *
 * DO NOT REUSE THE DEVELOPMENT VALUES from `server/.env`. They are committed
 * to this repository's history and are therefore public: anyone with the repo
 * can mint a valid station token or recompute an IP hash.
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   node scripts/generate-deploy-secrets.mjs
 */

import { randomBytes } from 'node:crypto';

/** 32 bytes. The zod schema floors every one of these at 32 CHARACTERS; base64 of 32 bytes is 44. */
const secret = () => randomBytes(32).toString('base64');

const values = {
  STATION_TOKEN_SECRET: secret(),
  STATION_CREDENTIAL_PEPPER: secret(),
  IP_HASH_PEPPER: secret(),
};

console.log(`
Production secrets — paste into Railway, then close this terminal.
Generated locally; they have not left this machine.
`);

for (const [key, value] of Object.entries(values)) {
  console.log(`${key}=${value}`);
}

console.log(`
What each one does, so you know what losing it costs:

  STATION_TOKEN_SECRET       Signs the rotating QR. Rotating it invalidates
                             every code on screen within one slot — that is
                             the GLOBAL panic button. To rotate without an
                             outage, set the old value as
                             STATION_TOKEN_SECRET_PREVIOUS for one deploy,
                             then drop it on the next.

  STATION_CREDENTIAL_PEPPER  Peppers each tablet's key before hashing. CHANGING
                             IT INVALIDATES EVERY PROVISIONED TABLET — every
                             stored hash was computed with the old pepper — so
                             every display needs re-provisioning from
                             /admin/stations. Set it once and leave it.

  IP_HASH_PEPPER             Peppers a request IP before it is stored. Changing
                             it does not break anything; it just makes old
                             origin hashes incomparable with new ones, so the
                             relay signal restarts from zero.

Never commit these. Never put them in client/.env.local — everything with a
NEXT_PUBLIC_ prefix is compiled into the browser bundle.
`);
