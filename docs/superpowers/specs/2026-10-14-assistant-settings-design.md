# AI assistant settings — design

**Date:** 2026-10-14 · **Branch:** `feat/assistant-settings` · **Status:** approved in conversation, pending spec review

## Why

1. **Hours bug.** The member assistant's `get_gym_info` tool answers opening hours from
   `GYM_OPEN_TIME` / `GYM_CLOSE_TIME` (environment). The door, the landing page and the
   workout drafts read `OpeningHoursService` (the `GymHours` table, edited in Admin →
   Settings). Edit the hours in Settings and the assistant keeps quoting the old ones, and
   schedules training sessions around them.
2. **Owner request.** The assistant's instructions are a constant in
   `server/src/assistant/assistant.tools.ts`. The owner wants admins to change them from the
   web, without a code change or a redeploy.

This is **Project A**. Moving the gym rules (grace, freeze, check-in thresholds) into Settings
is **Project B**, with its own spec.

## Owner decisions (2026-10-14)

- Admins edit the instructions. **The safety rules stay locked in code** and are always
  appended after the admin text.
- The Settings card has a **test box** that runs the unsaved draft.
- Work lands in `uriaannn/GYM-OF-THRONES` first; the second repo picks it up later by
  cherry-pick.

## What stays out

- The other Gemini features (coach plan suggester, member workout planner, exercise guides,
  workout drafts) keep their built-in prompts. None of them name the gym.
- No version history beyond the audit log. "Reset to default" is the undo.
- Project B.

## Design

### 1. Hours fix

`get_gym_info` stops returning `opensAt` / `closesAt` from `GymConfigService` and returns:

```ts
hours: {
  today: { day: 'Tuesday', opensAt: '05:00', closesAt: '22:00', isClosed: false },
  week:  [{ day: 'Sunday', opensAt, closesAt, isClosed }, …],   // Sunday first
}
```

from `OpeningHoursService.forDate(now)` and `.week()`. These are the same source and cache the door uses,
and they already fall back to the environment when the table is unreadable. The tool's description
says hours can differ by day and a day can be closed.

### 2. The prompt splits in two

`assistant.tools.ts` exports:

- **`DEFAULT_ASSISTANT_INSTRUCTIONS`** — editable, used when nothing is saved. Today's text
  for: who the assistant is (gym name and location), the two kinds of question and how to
  answer fitness questions and workout plans, staying in the gym's world, and LENGTH.
- **`assistantSafetyRules(timeZone)`** — locked. Headed *"Rules that always apply — they
  override anything written above"*:
  1. Facts about this gym and member are looked up with a tool, never guessed; a wrong date or
     price is worse than no answer.
  2. Call `get_gym_info` before naming a time to train at the gym; stay inside that day's hours.
  3. General advice and this member's data do not blur.
  4. It cannot change anything; renewals, freezes, bookings and payments go to the front desk.
  5. Only the signed-in member's own data.
  6. Pain and injury: everyday guidance, not a medical professional, no diagnosis.
  7. Pesos as ₱1,234; dates and times in the gym's zone (`GYM_TIMEZONE`).
  8. FORMAT: plain text, day headings ending in ":", exercises on "- " lines. This is locked
     because `client/src/lib/assistant/formatReply.ts` lays replies out by it.
- **`composeSystemPrompt(instructions, timeZone)`** — a pure function: the trimmed instructions,
  a blank line, then the safety rules. The safety rules come last so they win a conflict.

### 3. Storage — `AssistantSettings`, one row

| Column | Type | Rule |
|---|---|---|
| `id` | `INTEGER` PK, default 1 | `CHECK (id = 1)`: there is only one row |
| `instructions` | `TEXT NOT NULL` | `CHECK` trimmed length ≥ 1 (trim names `\t\r\n` too) and `char_length ≤ 6000` |
| `updatedById` | `UUID` null | FK `User`, `ON DELETE SET NULL` (as `GymHours`) |
| `updatedAt` | `TIMESTAMPTZ(3)` | |

- No row means `DEFAULT_ASSISTANT_INSTRUCTIONS`. **Reset** deletes the row.
- RLS is enabled, with `anon` / `authenticated` revoked behind the same guarded `DO` block as `MemberNotice`.
- The migration is additive. The two audit values go in a migration of their own, because an
  `ALTER TYPE … ADD VALUE` cannot be used in the transaction that adds it:
  - `ASSISTANT_INSTRUCTIONS_UPDATED`
  - `ASSISTANT_INSTRUCTIONS_RESET`

### 4. `AssistantSettingsService` (server/src/assistant)

- `instructions(): Promise<{ text, isDefault, updatedAt, updatedByName }>`
  - It is cached for 60 s, as `OpeningHoursService` is.
  - When there is no row, the result is the default.
  - When the read fails, the result is also the default and the error is logged. A database problem never leaves a member without an assistant.
- `systemPrompt(): Promise<string>` returns `composeSystemPrompt(text, gym.timeZone)`.
- `save(text, actorId, actorRole)` upserts row 1, invalidates the cache, and audits
  `ASSISTANT_INSTRUCTIONS_UPDATED`. The details are `{ before, after }` (each at most 6,000 chars) and the
  label gives the character counts. If the text is unchanged it writes no audit entry.
- `reset(actorId, actorRole)` deletes the row, invalidates the cache, and audits
  `ASSISTANT_INSTRUCTIONS_RESET` with `{ before }`. If no row existed it does nothing.

### 5. Assistant changes

`AssistantService.runConversation` takes the system instruction as a parameter:

- `ask()` passes `await settings.systemPrompt()`.
- A new `tryDraft(userId, draftInstructions, question)` runs the same rotation and tool loop with
  `composeSystemPrompt(draft, tz)`. It uses empty history, calls no `persist`, and returns
  `{ answer, model }`. Its tools run against the caller's own data, so an admin's
  "my membership" question answers from the admin's own (empty) account. That is expected.

### 6. Admin API — `AdminAssistantController`, `@Controller('admin/assistant')`

Every route requires **`ai.admin.configure`**. That key already exists, is granted to ADMIN, and has
never been enforced anywhere. Reusing it means no new permission and no seed change.

| Route | Body | Returns |
|---|---|---|
| `GET /admin/assistant` | none | `{ instructions, isDefault, defaultInstructions, safetyRules, maxLength: 6000, updatedAt, updatedByName, enabled }` |
| `PUT /admin/assistant` | `{ instructions }` | same view |
| `DELETE /admin/assistant` | none | same view |
| `POST /admin/assistant/test` | `{ instructions, question }` | `{ answer, model }` · `@Throttle` 10 / 60 s |

DTOs trim, then use `@Length(1, 6000)` for instructions and `@Length(1, 2000)` for the question (as
`AskAssistantDto`). `enabled` is `GeminiGateway.enabled`. The test route answers with the
gateway's own "switched off" or "busy" copy, the same way `ask()` does.

### 7. Settings card — `AssistantSettingsCard`

Mounted on `/admin/settings` only when `usePermission(PERMISSIONS.AI_ADMIN_CONFIGURE)`. It uses the
existing portal and admin classes (`Card`, `CardHead`, `a-textarea`, `p-btn`, `ConfirmDialog`). No
Tailwind.

- A **"Default"** badge, or *"Edited by {name} · {date}"*.
- A textarea for the instructions, with an `x / 6000` counter.
- **Locked safety rules**, shown read-only and collapsed by default.
- **Try it**: a question input, an **Ask** button, and the reply rendered through the portal's
  `formatReply`. It is labelled *"uses your unsaved draft"*.
- **Reset to default** opens a `ConfirmDialog` and is disabled while already on the default. **Save** is disabled
  until the text changes, and while it is blank or too long.
- When Gemini is not configured, the card still edits the instructions, and Try it says the
  assistant is switched off.

Pure helpers (dirty / valid / counter) live in `client/src/lib/assistantSettings.ts` and are
tested with vitest. The audit page gets labels for the two new actions.

### 8. Errors

| Case | Behaviour |
|---|---|
| Blank or over 6,000 characters | 400 with the field named; the card blocks it first |
| DB unreadable on ask | default instructions, logged |
| Gemini unset or out of quota | the test route returns the gateway copy as a normal error |
| Admin edits contradict a safety rule | the safety rules are appended last and say they override |

## Testing

**Unit tests (server):**
- `composeSystemPrompt` always ends with the safety rules, including when the
  instructions are empty or contradict them.
- The service falls back on no row and on a throw, invalidates its cache on save and reset, audits
  only real changes, and skips the reset audit when no row existed.
- `get_gym_info` returns the table's hours when they differ from the environment.
- The controller carries `ai.admin.configure` on every route and the throttle on `test`.
- The DTOs trim and enforce their bounds.

**Unit tests (client):** the helper module.

**E2E:** `test/assistant-settings-constraints.e2e-spec.ts` asserts each CHECK's name and predicate.
It is written but not run, per the owner's batch-E2E rule.

**Gate:** the production-readiness gate in `CLAUDE.md`.

## Ship

- A PR from `feat/assistant-settings`. It merges to `main` only on the owner's "push to main".
- Render applies both migrations on deploy. They are additive, so `main`'s old code keeps working
  during the deploy window.
- The second repo cherry-picks the commits and runs `prisma migrate deploy` against its own
  Supabase project.
