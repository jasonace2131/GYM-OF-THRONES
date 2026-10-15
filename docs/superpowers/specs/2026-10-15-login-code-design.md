# Login code (password, then an emailed 6-digit code) — design

Owner request, 2026-10-15: "an OTP in the email, for every login".

## Owner decisions (2026-10-15)

| Question | Answer |
|---|---|
| What the code does | **Password, then code.** The code is a second step after the password, not a replacement for it. |
| Who | **Everyone**: members, front desk, coaches, admins, DEV. |
| How often | **Every sign-in.** Staying signed in (token refresh) never asks again. A new sign-in always does. |
| Counter setup link (`/join`) | **The link counts.** A member who just set up their account from the emailed link is not asked for a code. |
| Delivery | Our API generates the code and **Resend** delivers it, the same as the setup link. Supabase sends nothing. |

## How it works

Supabase stays the identity provider. Every Supabase access token carries a `session_id` claim (one per sign-in, stable across token refreshes) and an `amr` claim (how that sign-in happened: `password`, `otp`/magic link, `invite`, `recovery`…). Both are signed by Supabase, so the API can trust them.

A **sign-in is verified** when either of these is true:
1. Its `session_id` has a row in `LoginVerification` with `verifiedAt` set, because the person entered the emailed code.
2. Its `amr` shows it was created by an **email link**, not a password: `otp` (magic link: the counter setup link), `invite` (staff invitation) or `recovery` (password reset). Opening a link sent to the inbox proves exactly what the code proves.

The API refuses everything an unverified sign-in asks for, except the two code endpoints.

### Ruling A — the password-reset link also counts
The owner ruled on the counter setup link. Under the same reasoning, the staff invitation link and the password-reset link are email-inbox proof too, so they count. **Cost if wrong:** someone who resets their password signs in without a second email. They already had to open an email to reset, so the protection is the same.

## Server

### Reading the claims
- `jwt-verifier.ts` keeps `session_id` (UUID) and the list of `amr` methods, and drops the rest as today.
- A token **without** `session_id` is refused (401 "Invalid or expired token"). Supabase has issued it on every access token for years, and a sign-in we cannot identify cannot be verified.
- `request.authSession = { sessionId, viaEmailLink }` is attached beside `request.user`.

### The gate
- **In `AuthGuard`,** after provisioning and the status check: if the route is not `@AllowUnverifiedLogin()` and the sign-in is not verified, throw `401 LOGIN_CODE_REQUIRED`.
- **The same check runs in `StationTokenAccessGuard`'s staff fallback**, which verifies JWTs by hand. A shared helper keeps the two paths identical.
- **Positive cache.** Verified `session_id`s are cached in memory (LRU, 10,000 entries) so a verified sign-in costs no extra query per request. Unverified results are never cached, so a code entered on one request takes effect on the next.
- **Sign-out needs no server work.** The Supabase session ends, and its `session_id` is never seen again.

### Kill switch: `LOGIN_CODE_REQUIRED` (env, default `true`)
- This is the escape hatch for when email is down: Resend misconfigured, daily quota hit, a domain not verified.
- **Fail closed:** with the gate on and email broken, nobody can finish signing in, admins included. Setting `LOGIN_CODE_REQUIRED=false` on Railway or Render and restarting turns the gate off for everyone.
- At boot, if the gate is on but `EmailService` is disabled (no `RESEND_API_KEY` / `RESEND_FROM`), the API **logs an error** and still enforces the gate. The sign-in screen then says the code could not be sent.
- Local development sets it to `false` in `server/.env`. The test env sets it explicitly per test.

### `LoginVerification` table (one row per Supabase sign-in)

| Column | Type | Notes |
|---|---|---|
| `sessionId` | UUID, PK | The Supabase `session_id`. |
| `userId` | UUID FK → `User`, `ON DELETE CASCADE` | |
| `codeHash` | `CHAR(64)`, nullable | HMAC-SHA256 of the code; null after a successful verify. |
| `codeExpiresAt` | timestamptz, nullable | 10 minutes after sending. |
| `attempts` | int, default 0 | Wrong guesses against the current code. |
| `sendCount` | int, default 0 | Codes sent for this sign-in. |
| `lastSentAt` | timestamptz, nullable | |
| `verifiedAt` | timestamptz, nullable | |
| `createdAt` | timestamptz | |

**CHECK constraints:**
- `codeHash` matches `^[0-9a-f]{64}$`;
- `attempts` is between 0 and 5;
- `sendCount` is between 0 and 5;
- a code hash and its expiry are present together or absent together;
- `verifiedAt` is not before `createdAt`.

RLS is enabled, and `anon`/`authenticated` are revoked, as on every other table. There is an index on `userId`.

### Code rules
- **Six digits**, from `crypto.randomInt(0, 1_000_000)`, zero-padded.
- **Stored as HMAC-SHA256** with key `IP_HASH_PEPPER`, over `login-code:v1:<sessionId>:<code>` (domain-separated). Six digits are trivially brute-forced from a plain hash, and keying the HMAC with a server secret makes a leaked table useless. Reusing an existing required secret means no new env var to forget.
- **Valid for 10 minutes.**
- **5 wrong attempts burn the code.** A new one must be requested.
- **A new code replaces the previous one.** Only the latest code works.
- **Resend cooldown is 60 seconds,** and each sign-in gets at most **5 codes**. After that the person signs in again, which starts a new sign-in.
- **Per-account ceiling: 10 codes per hour** across all sign-ins. This protects the inbox and the Resend quota (free plan: 100 per day).
- Comparison is constant-time.

### Endpoints (new `LoginCodeController`, `/auth/login-code`)
Both are authenticated: they need the Supabase token. Both are `@AllowUnverifiedLogin()` and throttled.

- **`POST /auth/login-code`** sends (or re-sends) a code for the caller's current sign-in.
  - Returns `{ sentTo: "j•••@gmail.com", resendAvailableAt, expiresAt }`.
  - If the sign-in is already verified, returns `{ verified: true }` and sends nothing.
  - If a code was sent less than 60 seconds ago, returns the existing state without sending.
  - Errors:
    - `LOGIN_CODE_SEND_LIMIT` (429) when the per-sign-in or hourly cap is hit;
    - `LOGIN_CODE_EMAIL_FAILED` (503) when Resend refuses or is not configured. The row is not counted as sent.
  - Throttle: `default` 5 per minute, `origin` 30 per minute.
- **`POST /auth/login-code/verify`** with `{ code: "123456" }`.
  - Success: `{ verified: true }`. Sets `verifiedAt`, clears the hash and warms the cache.
  - Errors:
    - `LOGIN_CODE_INVALID` (422, `details.attemptsLeft`);
    - `LOGIN_CODE_EXPIRED` (422);
    - `LOGIN_CODE_LOCKED` (422) after 5 wrong attempts, until a new code is requested.
  - Throttle: `default` 10 per minute, `origin` 60 per minute.
  - The `{ code }` DTO accepts exactly 6 digits after trimming spaces.

### Email
`EmailService.sendLoginCode(to, { name, code })`:
- subject "Your Gym of Thrones sign-in code: 123456";
- the body is the code large, then "It expires in 10 minutes. If you didn't try to sign in, change your password.";
- built with the existing template style (`escapeHtml`).

### Realtime (live chat) — closing the side door
The browser subscribes to Supabase Realtime directly with its token, so the API gate never sees it. A migration adds to the existing private-channel RLS policy: the subscribing JWT's sign-in must be verified, either by a `LoginVerification` row with `verifiedAt` for `auth.jwt()->>'session_id'`, or by an email-link `amr`. A password-only sign-in that has not entered its code then cannot receive chat messages.

When `LOGIN_CODE_REQUIRED=false`, this database rule cannot read the env var. So it checks a one-row `LoginCodeSetting` table that the API writes at boot from the env var. *(Alternative considered: dropping the Realtime check. Rejected because it leaves chat readable with a stolen password, which is the exact threat this feature exists for.)*

## Client

- **Login page, two steps.**
  1. The password works as today. Then `GET /me` either returns the profile (the code is off, or the sign-in is already verified) or `401 LOGIN_CODE_REQUIRED`.
  2. On `LOGIN_CODE_REQUIRED`, the page calls `POST /auth/login-code` and shows the code step:
     - "We emailed a 6-digit code to j•••@gmail.com";
     - one input with `inputmode="numeric"`, `autocomplete="one-time-code"` and paste support;
     - **Verify**;
     - **Resend code**, with a countdown;
     - **Use a different account**, which signs out.

     After verifying, it runs the existing `/me` → `destinationFor(next)` redirect.
  3. Errors are shown in words, never as codes: wrong code with attempts left, expired, locked, too many codes, and "We couldn't send the email — ask the gym" for an email failure.
- **Arriving with a session that still needs a code** (a reload mid-step, a deep link, or the admin layout bouncing a 401): the login page checks for an existing session on mount. If `/me` says `LOGIN_CODE_REQUIRED`, it goes straight to step 2 without asking for the password again.
- **`apiFetch` handles this anywhere:** on `LOGIN_CODE_REQUIRED` it sends the browser to `/login?next=<current path>`. The exception is when the current page is already `/login`, `/join/*`, `/invite/*` or `/reset-password`.
- **`RealtimeProvider`** connects only after `/me` has succeeded, which already implies a verified sign-in.
- **`/join` and `/invite`** need no change: their sessions come from email links, so they are verified by `amr`.

## Unaffected
- **The station display in credential mode** (`X-Station-Key`) and every `@Public()` route.
- **Member phones that are already signed in** stay signed in. After deploy, every existing session is unverified, because no row exists and it was made by password. So **everyone is asked for a code once, on their next request after the deploy.** Merge while the gym is closed.

## Testing
- **Unit tests:**
  - claim parsing (`session_id`, `amr`);
  - the gate: verified row, email-link `amr`, kill switch off, exempt routes, the station staff path;
  - code issue, verify and expiry;
  - attempts, cooldown, the per-sign-in cap and the hourly cap;
  - HMAC domain separation;
  - email-failure handling;
  - the login page's two steps and every error state;
  - `apiFetch` redirect rules.
- **E2E spec (written, run by the owner per the batch rule):**
  - every `LoginVerification` CHECK, by name and predicate;
  - the Realtime policy predicate.
- **Manual, per environment, before relying on it:**
  - decode a real access token and confirm `session_id` is present;
  - confirm the `amr` values for password, magic link, invite and recovery sign-ins on that Supabase project.

## Rollout
1. Have Resend verified and its env vars set on the API host **before** merging.
2. Merge outside opening hours. Every signed-in device asks for one code.
3. If email breaks: set `LOGIN_CODE_REQUIRED=false` on the API host and restart. Everyone signs in with the password alone until it is fixed.

## Out of scope
- "Remember this device" (declined: every sign-in).
- SMS or authenticator-app codes.
- Codes on the station display's credential mode.
