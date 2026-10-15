# Counter sign-up — design

**Date:** 2026-10-14 · **Branch:** `feat/counter-signup` · **Status:** design approved in conversation, pending spec review

## Why

A walk-in who decides to subscribe is turned into a member at the counter. Staff use the New
member drawer, or "Make member" on the visit. `POST /members` creates the account, sells the plan,
and emails a Supabase link. That flow has four defects:

1. **The member never sets a password.** The emailed link signs them in, and nothing ever asks
   for a password. Only the staff `InvitePage` and `ResetPasswordPage` call `updateUser`. The
   next time the member is signed out, they have to use "Forgot password".
2. **The link is Supabase's raw link.** It is minted with no `redirectTo` and lasts about an hour.
   A mail scanner that pre-fetches it uses it up. `email.service.ts` already records this, and it
   is why staff invitations stopped emailing Supabase links.
3. **The walk-in visit records no email,** so "Make member" leaves the email field blank. Name is
   optional on the dashboard's walk-in form and required on the Walk-ins page.
4. **A mistyped email cannot be fixed.** `UpdateMemberDto` has no email, so a typo strands the
   account.

Also, a staff-created member has no `dateOfBirth`, while self sign-up requires one.

## Owner decisions (2026-10-14)

- The front desk has no tablet, so there is **no QR code at the counter**. Everything goes by
  **email**.
- A walk-in **must give a name and an email** to buy a day pass.
- The member **pays at the counter** before the link goes out, so the link arrives with the
  subscription already active.
- On first use of the link, the member **sets a password once**. After that they use the normal
  login.
- The setup page **asks for their date of birth**, under the same rule as self sign-up.
- Staff **can correct a mistyped email** while the member has never signed in. The change is
  audited.

## What stays out

- Searching past walk-ins by name, phone or email.
- A screen that sells guest passes. None exists today, but the rules below still cover them.
- Showing or copying the setup link at the counter, or sending it by SMS.
- The minors-and-chat decision, which is still open in its own item. This work reuses the
  existing birth-date rule unchanged.
- Auditing member creation. It is not audited today, and this work does not add it.

## Design

### 1. Walk-in sale takes a name and an email

**DTO.** `SellWalkInDto` gains `guestEmail?`. Like `CreateMemberDto.email` and
`CreateStaffInvitationDto.email`, it is trimmed, lower-cased, `@IsEmail` and `@MaxLength(254)`.

**Service.** `WalkInService` covers both kinds, `WALK_IN` and `GUEST_PASS`. When there is no
`userId`:
- A missing `guestName` throws `GUEST_NAME_REQUIRED` (422).
- A missing `guestEmail` throws `GUEST_EMAIL_REQUIRED` (422).

These checks sit beside the existing `GUEST_WAIVER_REQUIRED` check, and the waiver check is
unchanged. `writeEntry` stores `guestEmail` only when there is no `userId`, as it already does for
`guestName` and `guestPhone`.

**Schema.** `CheckIn.guestEmail String?`, with one shape `CHECK`:

```sql
CONSTRAINT "CheckIn_guest_email_sane"
  CHECK ("guestEmail" IS NULL OR ("guestEmail" = lower(btrim("guestEmail"))
         AND char_length("guestEmail") BETWEEN 3 AND 254))
```

**The requirement is not a database CHECK, on purpose.** A `NOT VALID` "required" CHECK, like
`CheckIn_guest_waiver_required`, skips existing rows only when it is created. Postgres re-checks
it on every later `UPDATE`. Production already has account-less walk-ins with no email, and those
rows still get updated: check-out (`endedAt`), the auto-close job, voids, and conversion
(`convertedToUserId`). Every one of those updates would then fail with a 500. So the service
enforces "required", and the database enforces only the shape.

**Privacy.** `guestEmail` is handled exactly like `guestPhone`:
- It is read only by `GET /front-desk/check-ins/:id/guest` (`member.create`).
- It is never read by `toDeskGuest`, `CheckInRecordSource`, the desk feed, `DeskMember`, the
  payment detail presenter or reports.
- A presenter test pins its absence.
- The privacy page already lists "email address" under identity and contact, so its text does not
  change.

**Client.** `WalkInSheet` and `WalkInModal` each get a required **Email** field (`type="email"`).
`WalkInModal`'s name stops being optional, so both forms agree. `adminApi.sellWalkIn` sends
`guestEmail`.

### 2. "Make member" pre-fills the email

- `FrontDeskService.guestContact` and the `GET …/guest` response add `guestEmail`.
- `seedFromGuest` sets `email` from it.
- Everything else in `NewMemberDrawer` and `POST /members` stays as it is:
  - `MEMBER_EMAIL_TAKEN` still fires for an email that already belongs to a member.
  - "Sell a plan now" still takes payment in the same call.

### 3. Our own setup link — `MemberJoinLink`

This mirrors staff invitations (`StaffInvitation`, `invitation-token.ts`, `/invite/<token>`),
simplified to **one row per member**.

| Column | Type | Rule |
|---|---|---|
| `id` | `UUID` PK | |
| `userId` | `UUID` **unique**, FK `User` `ON DELETE CASCADE` | the member this link sets up. A link is meaningless without its member, so it must never block a delete |
| `tokenHash` | `CHAR(64)` unique | sha256 hex of the raw token, which is never stored. `CHECK ("tokenHash" ~ '^[0-9a-f]{64}$')` |
| `issuedAt` | `TIMESTAMPTZ(3)` | refreshed when the link is rotated |
| `expiresAt` | `TIMESTAMPTZ(3)` | `issuedAt + 7 days`. `CHECK ("expiresAt" > "issuedAt")` |
| `issuedById` | `UUID` null, FK `User` `ON DELETE SET NULL` (as `AssistantSettings.updatedById`) | the staff member who created, resent or re-addressed it |
| `usedAt` | `TIMESTAMPTZ(3)` null | set once, on accept. `CHECK ("usedAt" IS NULL OR "usedAt" >= "issuedAt")` |
| `createdAt` | `TIMESTAMPTZ(3)` | |

- RLS is enabled, and `anon` / `authenticated` are revoked behind the same guarded `DO` block as
  `AssistantSettings`.
- Tokens come from the existing `newInvitationToken()` / `hashInvitationToken()`, which give 43
  base64url characters and a sha256 hash. `MEMBER_JOIN_TTL_DAYS = 7`.
- **Rotation** (on create, resend and email change) upserts the row with a new `tokenHash`,
  `issuedAt` and `expiresAt`, and sets `usedAt` to null. The previous link dies at once. Rotation is
  refused once `usedAt` is set.

A new `MemberJoinService` (in `server/src/users`) owns the rotation, the email and the three
public steps.

**Who may get a link.** A link is issued only for a **member** (role `CLIENT`) who has **never
signed in**, meaning `lastSeenAt IS NULL` and `deletedAt IS NULL`. The reason is that a link is a
way into the account. A staff account gets `MEMBER_JOIN_STAFF_ACCOUNT` (409): otherwise a front-desk
login could re-address a never-signed-in staff account to its own inbox and claim it.
A member who has ever signed in cannot be given one by staff, so a desk login can never be used to
take over an active member's account. Such a member gets `MEMBER_ALREADY_SIGNED_IN` (409), and the
UI tells staff to point them at "Forgot password".

**Account creation at the counter** (`MembersService.create`):
- Replace `generateInviteLink`, which minted a link no one will use, with
  `SupabaseAdminService.createAuthUser(email)`.
- That calls `auth.admin.createUser({ email, email_confirm: false })`. "Already registered" maps to
  `MEMBER_EMAIL_TAKEN`, as it does today.
- The compensating `deleteUser` on a failed local create stays.
- After the transaction, and after the optional plan sale, the service calls
  `memberJoin.issue(user, actor)`. That rotates the link and sends the email, and the result
  becomes `emailSent`. `CreateMemberResult` keeps its shape.

**The email.**
- `EmailService.sendMagicLink` is replaced by `sendMemberJoin(to, { name, link, plan })`.
- Subject: "Your Gym of Thrones account is ready".
- The body:
  - "Hi {name}, your account at Gym of Thrones is ready."
  - When the member has a current membership: "Your {planName} plan runs until {endsOn}."
  - A **Set up my account** button pointing to `{appOrigin}/join/{token}`.
  - "This link works once and expires in 7 days. If it has expired, ask the front desk for a new
    one."
- `appOrigin` is `resolveAppOrigin(requestOrigin, CORS_ORIGIN)`, as staff invitations use it, so
  `POST /members` and the resend and email routes forward `@Headers('origin')`.
- The plan line reads the member's current or next membership at send time, and is left out when
  there is none.

**Public routes** — `MemberJoinController`, `@Controller('member-join')`, with the same
throttles as their staff equivalents:

| Route | Auth | Throttle | Does |
|---|---|---|---|
| `GET lookup?token=` | `@Public` | default 10/min, `origin` 30/min | `{ firstName, status: 'PENDING' \| 'USED' \| 'EXPIRED', email? }`. `email` is present only while `PENDING`. It is the full address, because the page needs it to recognise the right session (§4). A token holder can already sign into the account, so the email reveals nothing more. An unknown token or a deleted member gives `MEMBER_JOIN_NOT_FOUND` (404) |
| `POST claim-link` `{ token }` | `@Public`, 200 | default 5/min, `origin` 20/min | Refuses a used, expired or unknown link, and a link whose member is no longer `CLIENT` (`MEMBER_JOIN_STAFF_ACCOUNT`, 409, before Supabase is called). Mints `generateLink({ type: 'magiclink', email, options: { redirectTo: {appOrigin}/join/{token} } })`. If the minted link's Supabase user id is not the member's `supabaseId`, it logs a warning (member id, no token) and refuses with `MEMBER_JOIN_NOT_FOUND` (404), never returning the URL. Otherwise returns `{ url }`. A Supabase refusal is a 502 `MEMBER_INVITE_FAILED` with a generic message; Supabase's own text goes only to the log |
| `POST accept` `{ token, dateOfBirth }` | signed in | default | Requires the caller's `User.id` = `row.userId`, else `MEMBER_JOIN_WRONG_ACCOUNT` (403). Sets `usedAt` with a conditional `updateMany … where usedAt IS NULL`. For the link's own member it is idempotent: an already-used link or a count of 0 answers the same success (`dateOfBirthSaved: false`), so a double submit on a page that worked never reads as an error. Expiry is NOT checked here (Ruling 9): expiry gates the claim, and by the time `accept` runs the member is signed in through the link and their password is saved, while staff cannot resend to somebody who has signed in, so a 410 would strand them. Stores `dateOfBirth` (see below) only if the user has none |

- The token DTO is `StaffInvitationTokenDto`'s rule: `@Length(16,128)`, `@Matches(/^[A-Za-z0-9_-]+$/)`.
- `dateOfBirth` is `YYYY-MM-DD`. It is stored through the existing `asJoinableBirthDate`, which is
  exported from `jwt-verifier.ts` for this. That is the same rule as self sign-up: an implausible
  date, or one under 16, is not stored. The minors item owns that rule.
- On claim, expired or used links give `MEMBER_JOIN_EXPIRED` / `MEMBER_JOIN_USED` (410).

**Minting a magic link for an existing account is safe here.** Staff invitations refuse to mint
one, because there the account may already belong to someone else. Here the token was created
only for a `CLIENT` account that has never been signed into, it is delivered only to that
account's own email address, and it dies on first use, after 7 days, or when staff correct the
email. A claim re-checks that the account is still `CLIENT` and that the minted link signs into
exactly this member's Supabase account. That is the same trust as a Supabase magic link, but it
starts on a button press, so mail scanners cannot use it up.

**Staff routes** (on `MembersController`):
- `POST /members/:id/resend-invite` keeps its path and permission (`member.create`, `@Scope('user')`).
  It now calls `memberJoin.issue`, which rotates the link and emails it. It is refused with
  `MEMBER_ALREADY_SIGNED_IN` or `MEMBER_JOIN_USED`. `generateMagicLink` (no `redirectTo`) is
  deleted.
- New: `POST /members/:id/change-email` `{ email }`, under `member.create` and `@Scope('user')`.
  The member must be one who could get a link (never signed in, not deleted). The steps:
  1. A taken email gives `MEMBER_EMAIL_TAKEN`, checked against the local table and Supabase.
  2. Change Supabase first: `auth.admin.updateUserById(supabaseId, { email })`.
  3. Then, in ONE transaction, update `User.email` and delete the member's unused
     `MemberJoinLink` rows (Ruling 7). The old link went to the mistyped address, possibly a
     stranger's inbox, and a claim reads the email fresh, so it must die with the change.
  4. If that transaction fails, put the Supabase email back (best effort, logged at error level,
     as `create` does with `deleteUser`) and rethrow the original error.
  5. Write the audit row `MEMBER_EMAIL_CHANGED { before, after }` after the write, through the
     existing best-effort `recordAccountAction` (`AuditService.record`'s contract: a log line never
     fails the action).
  6. Finally `memberJoin.issue`, which creates and sends a fresh link to the new address. A throw
     there is caught and logged, and the route answers `emailSent: false`: never a 500 after the
     email has changed.
- **Audit:** `MEMBER_EMAIL_CHANGED` is a new `AuditAction`, in a migration of its own, because
  `ALTER TYPE … ADD VALUE` cannot share a transaction with code that uses the new value. The audit
  page gets a label for it.

### 4. The setup page — `/join/[token]`

`client/src/app/(auth)/join/[token]/page.tsx` renders `JoinPage`. It is noindex, like
`/invite/[token]`. Its pure helpers live in `client/src/lib/memberJoin.ts` (stage, copy, the
date-of-birth check) and are tested with vitest. `memberJoinApi` sits beside `inviteApi`.

| Stage | Shows |
|---|---|
| loading | — |
| dead | **used:** "This link was already used — sign in" with a Sign in button. **Expired:** "This link has expired. Ask the front desk to send a new one." **Not found, or any other server error code** (a mangled token the DTO refuses is `HTTP_400`): "This link isn't valid", ask the front desk. Only a failure with no code at all (the network) gets "We couldn't open this link" |
| signed out, or signed in as another account | "Hi {firstName}" and a **Set up my account** button. It calls `claim-link`, then `window.location.assign(url)` |
| signed in as this member | The password form: new password plus confirm, at least 8 characters, run through `normalisePassword`. It also asks for **date of birth** (`type="date"`, required) |

- On submit the page calls `supabase.auth.updateUser({ password })` **before** `accept`, then
  `router.replace(homeFor(me.permissions))`. The portal's existing ConsentGate then collects
  terms, waiver and privacy.
- **No sessionStorage marker.** A join link only exists for an account with no password yet, so
  the signed-in stage always asks for one. If `accept` fails after the password is set, a retry
  just sets the password again.
- "Signed in as this member" means that the signed-in session's email (`supabase.auth` session
  `user.email`, which `InvitePage` already reads) equals the `email` the lookup returned, trimmed
  and compared case-insensitively. Emails are unique, so equal emails mean the same account. It
  fails closed: a lookup with no email, or a blank one, matches no session at all.
  - Any other session gets the button stage. Claiming replaces that session.
  - This check runs before `updateUser`, so an admin signed in on the desk PC can never change
    their **own** password by opening a member's link.
  - `accept`'s caller check stays as the server-side authority.
- Styling uses the existing auth page classes (`AuthBrandPanel`, `PasswordInput`). No Tailwind.

### 5. Admin UI

- **`MemberDrawer`:**
  - "Resend invite" keeps its visibility rule (`member.create` and `lastSeenAt === null`). Its copy
    becomes "Send a new setup link to {email}? The old link stops working."
  - A new **Change email** action has the same visibility. It opens a modal with one email field,
    calls `adminApi.changeMemberEmail`, and on success reports whether the email went out.
  - Both show `MEMBER_ALREADY_SIGNED_IN` as "They've already signed in — ask them to use Forgot
    password."
- **`NewMemberDrawer`:** after create, the copy says the setup link was emailed to {email}. The
  existing `emailSent: false` path and its Resend button stay. Resend reads `emailSent`: only
  `true` shows "Setup link sent."; `false` keeps the hint and the button.
- **Resend in `MemberDrawer`** reads `emailSent` too: on `false` the dialog stays open with "The
  setup link email may not have gone out. Check the address, or try again later."

### 6. Errors

| Case | Behaviour |
|---|---|
| Account-less walk-in with no name or email | 422 `GUEST_NAME_REQUIRED` / `GUEST_EMAIL_REQUIRED`. The forms block it first |
| Resend or change email for a member who has signed in | 409 `MEMBER_ALREADY_SIGNED_IN`, with "Forgot password" copy |
| Link used or expired | 410 on claim. On accept, for the link's own member: used is the idempotent success, and expiry is not checked (Ruling 9). Another account gets 403 `MEMBER_JOIN_WRONG_ACCOUNT` either way. The page shows the dead stage |
| Claim on a link whose member is now staff | 409 `MEMBER_JOIN_STAFF_ACCOUNT`, before Supabase is called |
| Claim mints a link for a different Supabase account | 404 `MEMBER_JOIN_NOT_FOUND`, logged at warn. No URL |
| Supabase refuses the claim's link | 502 `MEMBER_INVITE_FAILED`, "Could not start account set-up. Try again in a moment." Supabase's text is logged only |
| Resend or change email for a staff account | 409 `MEMBER_JOIN_STAFF_ACCOUNT`. Staff accounts are set up from Staff & Access |
| Link opened by another signed-in account | the button stage. Claiming switches the session |
| `SUPABASE_SERVICE_KEY` unset | the existing 503 `MEMBER_CREATE_DISABLED`, also on claim-link and change-email |
| Resend not configured, or the send fails | `emailSent: false`. The drawers show the existing "may not have gone out" line and a Resend button. A change-email whose new link cannot be issued also answers `emailSent: false` |
| `/join/*` missing from Supabase's Redirect URLs | Supabase falls back to its Site URL, so the member lands signed in with no password step. This is a **deploy step** (see Ship), not a code path |

The new error codes go in the `shared/src/types/api.types.ts` union.

## Testing

**Server unit:**
- The walk-in DTO lower-cases and trims email. The service requires name and email only when there
  is no `userId`, for both kinds, and stores `guestEmail` only then.
- `guestContact` returns `guestEmail`. The desk and payment presenters never output it.
- `MemberJoinService`:
  - rotation replaces the hash, refreshes the expiry and clears `usedAt`;
  - it refuses a signed-in or deleted member, and refuses once used;
  - the email carries `/join/<token>` and the plan line only when a membership exists.
- `MemberJoinService` public steps:
  - lookup statuses, with `email` present only while `PENDING`;
  - claim-link refuses used and expired links and a staff account, mints `magiclink` with the
    `/join/<token>` `redirectTo`, and refuses a link minted for another Supabase account;
  - accept checks the caller (also on a used or expired link), finishes an expired link for its
    own member, and is single-use under a race (`count === 0`);
  - accept stores the birth date only when it is joinable and none is on file.
- `MembersService.create` uses `createAuthUser`, issues a link, and keeps the compensating delete.
- `changeEmail`: preconditions; Supabase first, then local, with the unused link deleted in the
  same transaction; the revert when that transaction fails; the audit row; a new link, and
  `emailSent: false` when issuing it throws.
- The controllers carry the right permissions and throttles.

**Client unit:**
- `lib/memberJoin.ts`: stages, copy, the date-of-birth check. Pin these cases:
  - another account's session never reaches the password stage;
  - a mixed-case session email still matches.
- `seedFromGuest` with an email.
- `adminApi` wrappers: `sellWalkIn` with `guestEmail`, `changeMemberEmail`, and `memberJoinApi`.
- The audit label.

**E2E:** `test/counter-signup-constraints.e2e-spec.ts` asserts each new CHECK by name and
predicate (`CheckIn_guest_email_sane` and the `MemberJoinLink` checks). It is written, not run, per
the owner's batch-E2E rule.

**Gate:** the production-readiness gate in `CLAUDE.md`.

## Ship

- **Migrations.** There are two, and both are additive:
  - one adds the `MEMBER_EMAIL_CHANGED` enum value;
  - one adds `CheckIn.guestEmail` and its CHECK, and creates `MemberJoinLink`.

  `main`'s old code ignores both during the deploy window.
- **Before testing.** In each Supabase project, add `https://<site>/join/*` to Authentication →
  URL Configuration → Redirect URLs. For local work, also add `http://localhost:3000/join/*`.
  `/invite/*` is already there for staff.
- **Email.** It only arrives if `RESEND_API_KEY` and `RESEND_FROM` are set on Render. Otherwise
  every create reports `emailSent: false`.
- **PR.** The PR comes from `feat/counter-signup` and merges to `main` only on the owner's "push to
  main".
- **Second repo.** It cherry-picks these commits after the assistant-settings ones, then runs
  `migrate deploy` and `db seed`.
