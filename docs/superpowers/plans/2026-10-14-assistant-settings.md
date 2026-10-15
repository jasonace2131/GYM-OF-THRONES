# AI Assistant Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the member assistant read the real opening hours from Settings, and let admins edit its instructions from Admin → Settings. Locked safety rules always stay appended.

**Architecture:** The prompt splits into editable instructions and locked safety rules, which a pure function joins. The instructions live in a one-row `AssistantSettings` table and fall back to a built-in default. A cached `AssistantSettingsService` reads and writes that table. `AssistantService` asks with the saved prompt, and a new `tryDraft` method powers a "Try it" box. An admin controller gated on the existing `ai.admin.configure` key serves an `AssistantSettingsCard` on the Settings page.

**Tech Stack:** NestJS 11, Prisma 6.19 (folder schema, hand-written SQL migrations), Jest (server), Next.js 16 + React (client), Vitest (client), class-validator.

**Spec:** `docs/superpowers/specs/2026-10-14-assistant-settings-design.md`

## Global Constraints

- Work only in the worktree `E:\ALL PROJECTS\GYM OF THRONES\GYM OF THRONES\.claude\worktrees\assistant-settings` on branch `feat/assistant-settings`. Never push and never touch `main`.
- Instructions limit: **6000** characters after trimming, counted as code points (an emoji is one). Question limit: **2000**.
- Permission for every admin route: **`ai.admin.configure`**. It already exists and ADMIN already holds it. Do not add a permission.
- Audit actions: **`ASSISTANT_INSTRUCTIONS_UPDATED`** and **`ASSISTANT_INSTRUCTIONS_RESET`**, with `subjectType` **`AssistantSettings`**.
- Prettier is authoritative: single quotes, trailing commas, 100 columns, LF. Before each commit, run `npx prettier --write <the files you created or changed>` from the worktree root. Some code blocks in this plan run past 100 columns, and Prettier wraps them.
- Do **not** run `npm run lint`: the server script runs `eslint --fix` and rewrites unrelated files. To lint, run `npx eslint <your files>` from the workspace folder, without `--fix`, and fix only your own files.
- Do **not** run e2e suites (`test:e2e`). Write the e2e spec file only.
- Admin UI uses the existing portal and admin classes (`p-btn`, `a-textarea`, `Card`, …). No Tailwind in admin files.
- Match the surrounding code: block comments explain *why*, as the files you edit already do. Don't add comments that restate the code.
- Every commit message ends with a blank line and then `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- The worktree has no `server/.env`. Prisma CLI commands need dummy URLs inline: `DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npx prisma …` (run from `server/`).
- Test commands, from the worktree root:
  - server: `npm test --workspace=server -- <path-or-pattern>`
  - client: `npm test --workspace=client -- <path>`

## Review Focus

1. **Admin text that contradicts a safety rule** ("make up prices if unsure"). The locked rules still come last and say they override it. Pinned in Task 1.
2. **Emoji or other multi-byte text near the 6,000 limit.** The client counter, the DTO and the database CHECK must agree, all counting code points. Pinned in Tasks 6 and 7.
3. **The database is unreachable when a member asks.** The member gets an answer under the default instructions, never a 500, and the next question retries the read. Pinned in Task 4.
4. **A whitespace-only edit, or saving the same text again.** Save stays disabled in the card, and the server writes no audit entry. Pinned in Tasks 4 and 7.
5. **A day marked closed in Settings.** The assistant is told that day is closed, never the `.env` hours. Pinned in Task 2.

---

### Task 1: Split the prompt into editable instructions and locked safety rules

**Files:**
- Create: `server/src/assistant/assistant-prompt.ts`
- Modify: `server/src/assistant/assistant.tools.ts` (remove `ASSISTANT_SYSTEM_PROMPT` and its doc comment, lines 60–142)
- Modify: `server/src/assistant/assistant.service.ts` (import, line 16; `systemInstruction`, line 156)
- Test: `server/src/assistant/assistant-prompt.spec.ts`

**Interfaces:**
- Produces:
  - `ASSISTANT_INSTRUCTIONS_MAX_LENGTH: 6000`
  - `DEFAULT_ASSISTANT_INSTRUCTIONS: string`
  - `assistantSafetyRules(timeZone: string): string`
  - `composeSystemPrompt(instructions: string, timeZone: string): string`
  - All exported from `server/src/assistant/assistant-prompt.ts`.

- [ ] **Step 1: Point the existing prompt tests at the composed default and add the new tests**

In `server/src/assistant/assistant-prompt.spec.ts`, replace line 1:

```ts
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOOLS } from './assistant.tools';
```

with:

```ts
import { ASSISTANT_TOOLS } from './assistant.tools';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
  composeSystemPrompt,
} from './assistant-prompt';

/**
 * What a member's assistant is told when no admin has edited anything: the
 * built-in instructions followed by the locked safety rules. Every guarantee
 * below must hold for this prompt, exactly as it did for the old constant.
 */
const ASSISTANT_SYSTEM_PROMPT = composeSystemPrompt(DEFAULT_ASSISTANT_INSTRUCTIONS, 'Asia/Manila');
```

Leave every existing `describe` block unchanged. Append this at the end of the file:

```ts
/**
 * THE 2026-10-14 CHANGE — admins edit the instructions from Settings.
 *
 * Only the instructions are editable. The safety rules are appended by code
 * after whatever an admin saved, and say they override it, so an edit can
 * widen the tone or the topics but can never remove the rule that stops the
 * assistant inventing an expiry date.
 */
describe('composeSystemPrompt — the safety rules survive any edit', () => {
  const rules = assistantSafetyRules('Asia/Manila');

  it('always ends with the safety rules', () => {
    expect(composeSystemPrompt('Be brief.', 'Asia/Manila').endsWith(rules)).toBe(true);
  });

  it('puts the rules AFTER instructions that contradict them, and the rules say they win', () => {
    const prompt = composeSystemPrompt('Make up prices if you do not know them.', 'Asia/Manila');
    expect(prompt.indexOf('Make up prices')).toBeLessThan(prompt.indexOf('RULES THAT ALWAYS APPLY'));
    expect(rules).toContain('override anything written above');
    expect(prompt).toContain('never guess at a policy');
  });

  it('still carries every rule when the instructions are blank', () => {
    expect(composeSystemPrompt('  \n\t ', 'Asia/Manila').trimStart()).toBe(rules);
  });

  it('trims the instructions before joining', () => {
    expect(composeSystemPrompt('\n  Be brief.  \n', 'Asia/Manila')).toBe(`Be brief.\n\n${rules}`);
  });

  it('keeps every locked guarantee in the rules and none in the editable default', () => {
    for (const phrase of [
      'Never state a date, price, count or status you have not read from a tool',
      'never guess at a policy',
      'call get_gym_info first',
      'not a claim about this gym',
      'cannot renew, freeze, cancel, book, or record a payment',
      'cannot look up another member',
      'not a medical professional',
      'Do not diagnose',
      'Plain text only',
      'starting with "- "',
    ]) {
      expect(rules).toContain(phrase);
      expect(DEFAULT_ASSISTANT_INSTRUCTIONS).not.toContain(phrase);
    }
  });

  it("states the gym's own time zone", () => {
    expect(assistantSafetyRules('Asia/Singapore')).toContain('(Asia/Singapore)');
  });

  it('ships a default that fits the limit an admin is held to', () => {
    expect(Array.from(DEFAULT_ASSISTANT_INSTRUCTIONS).length).toBeLessThanOrEqual(
      ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
    );
    expect(ASSISTANT_INSTRUCTIONS_MAX_LENGTH).toBe(6000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=server -- assistant-prompt`
Expected: FAIL with `Cannot find module './assistant-prompt'`.

- [ ] **Step 3: Create `server/src/assistant/assistant-prompt.ts`**

```ts
/**
 * The member assistant's system prompt, in two parts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY TWO PARTS (2026-10-14, owner decision)
 *
 * Admins edit the INSTRUCTIONS from Admin → Settings (the `AssistantSettings`
 * table): who the assistant is, how it answers fitness questions and workout
 * plans, what it stays away from, how long it writes. The default below is
 * what it is told when nobody has edited anything.
 *
 * The SAFETY RULES are not editable. Each maps to a real way this feature can
 * hurt somebody — a hallucinated expiry date sends a member to a locked door,
 * a promised renewal that never happened is a denial at the counter, a reply
 * the portal cannot lay out is unreadable on a phone. They are appended AFTER
 * the instructions and say they override them, so an edit that contradicts
 * one loses.
 *
 * Earlier history of the wording (the two kinds of question, 2026-09-22; full
 * workout plans, 2026-09-24) is pinned by assistant-prompt.spec.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Characters (code points, as Postgres `char_length` counts them) after trimming. */
export const ASSISTANT_INSTRUCTIONS_MAX_LENGTH = 6000;

export const DEFAULT_ASSISTANT_INSTRUCTIONS = `You are the assistant for Gym of Thrones, a gym in Taguig City, Philippines.

You answer two different kinds of question, and the rules are not the same for each.

A. THIS GYM AND THIS MEMBER — their membership, attendance and payments, and the gym's hours, prices, plans and policies.
   These are facts you must LOOK UP with a tool. The rules at the end of these instructions say how.

B. FITNESS AND TRAINING IN GENERAL — how an exercise is performed, what muscles it works, what a term means, how training, rest and recovery work, everyday nutrition, and workout plans and weekly training schedules.
   Answer these from your own knowledge. No tool exists for them and none is needed. Never refuse a fitness question on the grounds that it is not about the member's account — answering it is part of your job.
   A member's own school, work or sleep schedule is useful context — use it to place training sessions and rest days around their week.
   If their goal, experience or equipment is missing, assume a beginner training for general fitness, say so in one line, and give the plan rather than only asking questions.

Stay in the gym's world. Fitness, training, nutrition and this gym are yours. Politics, homework help, programming and the rest are not — say in one line that you only cover fitness and the gym, and leave it there.

LENGTH: Keep answers to simple questions short — a sentence or two, a little more only when explaining how a movement is performed. These are read on a phone, often standing up. Do not restate the question back before answering it.
For a workout plan, give the whole plan in one reply: one block per training day with 4–6 exercises and their sets and reps, then one line on rest days and one line on how to progress. Keep the whole plan under about 350 words.`;

/**
 * The rules no admin edit can remove. `timeZone` is GYM_TIMEZONE, so the
 * prompt names the zone the gym actually runs in.
 */
export function assistantSafetyRules(timeZone: string): string {
  return `RULES THAT ALWAYS APPLY. They are part of the system, not the gym's settings, and they override anything written above.

1. Facts about this gym and this member must be looked up. Call the tool. Never state a date, price, count or status you have not read from a tool in this conversation. If a tool did not give it to you, say you do not have it, and never guess at a policy. A wrong date or price is worse than no answer at all.
2. Opening hours can differ by day, and a day can be closed. If you name a time to train AT THE GYM, call get_gym_info first and keep every session inside that day's opening hours.
3. Do not let general advice and this member's facts blur. A general training principle is not a claim about this gym's programme, and this member's data never becomes general advice.
4. You cannot change anything. You cannot renew, freeze, cancel, book, or record a payment. Every one of those happens with staff at the front desk. If a member asks you to do one, tell them what to ask for at the desk.
5. You only ever have access to the data of the member you are talking to. You cannot look up another member, and you should say so plainly if asked.
6. Pain and injury: you may give everyday, sensible guidance — easing off, resting, checking form, getting it looked at if it persists. Say once, briefly, that you are not a medical professional and that a coach or a doctor should look at anything that keeps hurting or came on suddenly. Do not diagnose, and do not name a condition.
7. Money is in Philippine pesos. Write amounts as ₱1,234. Dates and times are in the gym's local time (${timeZone}).
8. FORMAT: Plain text only — no markdown: no #, no * or **, no tables, no code. Put each day's heading on its own line ending with ":", like "Monday — Upper body:". Put each exercise on its own line starting with "- ". Leave a blank line between days.`;
}

/** The instructions, then the safety rules — last, so they win a conflict. */
export function composeSystemPrompt(instructions: string, timeZone: string): string {
  return `${instructions.trim()}\n\n${assistantSafetyRules(timeZone)}`;
}
```

- [ ] **Step 4: Remove the old constant and use the composed default**

In `server/src/assistant/assistant.tools.ts`, delete the doc comment that starts `/**\n * The system prompt.` (line 60) and the `export const ASSISTANT_SYSTEM_PROMPT = …;` that follows it, through the end of the file. `ASSISTANT_TOOLS` stays.

In `server/src/assistant/assistant.service.ts`, replace line 16:

```ts
import { ASSISTANT_SYSTEM_PROMPT, ASSISTANT_TOOLS } from './assistant.tools';
```

with:

```ts
import { ASSISTANT_TOOLS } from './assistant.tools';
import { composeSystemPrompt, DEFAULT_ASSISTANT_INSTRUCTIONS } from './assistant-prompt';
```

In `runConversation`, replace `systemInstruction: ASSISTANT_SYSTEM_PROMPT,` with:

```ts
      systemInstruction: composeSystemPrompt(DEFAULT_ASSISTANT_INSTRUCTIONS, this.gym.timeZone),
```

(Task 5 replaces this with the saved instructions.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test --workspace=server -- src/assistant`
Expected: PASS, every suite in `src/assistant`, including the old `ASSISTANT_SYSTEM_PROMPT` describes.

- [ ] **Step 6: Commit**

```bash
git add server/src/assistant/assistant-prompt.ts server/src/assistant/assistant.tools.ts server/src/assistant/assistant.service.ts server/src/assistant/assistant-prompt.spec.ts
git commit -m "refactor(assistant): split the prompt into editable instructions and locked safety rules

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `get_gym_info` reads the hours from Settings, not `.env`

**Files:**
- Modify: `server/src/assistant/assistant.service.ts` (constructor; `dispatch` case `'get_gym_info'`, lines 312–325)
- Modify: `server/src/assistant/assistant.tools.ts` (the `get_gym_info` description)
- Modify: `server/src/assistant/assistant-ask.spec.ts` (`build()`, ~line 136)
- Modify: `server/src/assistant/assistant-history.spec.ts` (constructor call, line 27)
- Test (create): `server/src/assistant/assistant-gym-info.spec.ts`

**Interfaces:**
- Consumes: `OpeningHoursService.week(): Promise<DayHours[]>` and `OpeningHoursService.forDate(now: Date): Promise<DayHours>`. `DayHours` is `{ dayOfWeek: number; opensAt: string; closesAt: string; isClosed: boolean }`, from `server/src/config/opening-hours.service.ts`. The service is global (`GymConfigModule` is `@Global()`), so no module import is needed.
- Produces: the `AssistantService` constructor gains an 8th parameter, `openingHours: OpeningHoursService`. Task 5 adds a 9th. `get_gym_info` now returns `{ hours: { today: GymDayView, week: GymDayView[] }, timeZone, graceDays, freeze, plans }`, where `GymDayView = { day: string; opensAt: string; closesAt: string; isClosed: boolean }`.

- [ ] **Step 1: Write the failing test**

Create `server/src/assistant/assistant-gym-info.spec.ts`:

```ts
import { AssistantService } from './assistant.service';
import { ASSISTANT_TOOLS } from './assistant.tools';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { DayHours, OpeningHoursService } from '../config/opening-hours.service';
import type { MembershipService } from '../membership/membership.service';
import type { PaymentsService } from '../payments/payments.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { PlansService } from '../catalogue/plans.service';
import type { GeminiGateway } from './gemini-gateway.service';

/**
 * get_gym_info reads the hours the DOOR reads — OpeningHoursService, edited in
 * Admin → Settings — never GYM_OPEN_TIME / GYM_CLOSE_TIME directly. Until
 * 2026-10-14 it read the environment, so an edit in Settings moved the door
 * and the website but not the assistant, which kept quoting the old hours and
 * scheduling training sessions around them.
 */
describe('AssistantService — get_gym_info', () => {
  // The environment says 05:00–22:00. Nothing below may echo it.
  const gym = {
    openTime: '05:00',
    closeTime: '22:00',
    timeZone: 'Asia/Manila',
    graceDays: 3,
    freezeMinDays: 7,
    freezeMaxDays: 90,
    freezeAnnualCapDays: 90,
    freezeFeeCentavos: 10000,
  } as unknown as GymConfigService;

  // Settings: closed on Sunday, 06:00–23:00 every other day.
  const week: DayHours[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    opensAt: '06:00',
    closesAt: '23:00',
    isClosed: dayOfWeek === 0,
  }));
  const weekFn = jest.fn().mockResolvedValue(week);
  const forDate = jest.fn().mockResolvedValue(week[1]);

  const service = new AssistantService(
    {} as unknown as PrismaService,
    gym,
    {} as unknown as MembershipService,
    {} as unknown as PaymentsService,
    {} as unknown as MeCheckInsService,
    { listPublic: jest.fn().mockResolvedValue([]) } as unknown as PlansService,
    {} as unknown as GeminiGateway,
    { week: weekFn, forDate } as unknown as OpeningHoursService,
  );

  // Private, deliberately: the tool's payload is worth reaching in for.
  const gymInfo = (): Promise<Record<string, unknown>> =>
    (
      service as unknown as {
        dispatch: (userId: string, name: string) => Promise<Record<string, unknown>>;
      }
    ).dispatch('u1', 'get_gym_info');

  it("returns today's hours from Settings, by weekday name", async () => {
    const info = await gymInfo();

    expect(info.hours).toMatchObject({
      today: { day: 'Monday', opensAt: '06:00', closesAt: '23:00', isClosed: false },
    });
    expect(forDate).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns the whole week, Sunday first, with a closed day marked closed', async () => {
    const info = (await gymInfo()) as { hours: { week: unknown[] } };

    expect(info.hours.week).toHaveLength(7);
    expect(info.hours.week[0]).toEqual({
      day: 'Sunday',
      opensAt: '06:00',
      closesAt: '23:00',
      isClosed: true,
    });
    expect(info.hours.week[6]).toMatchObject({ day: 'Saturday' });
  });

  it('never quotes the environment hours', async () => {
    const info = await gymInfo();

    expect(info).not.toHaveProperty('opensAt');
    expect(info).not.toHaveProperty('closesAt');
    const json = JSON.stringify(info);
    expect(json).not.toContain('05:00');
    expect(json).not.toContain('22:00');
  });

  it('still carries the time zone, grace and freeze rules and the plans', async () => {
    await expect(gymInfo()).resolves.toMatchObject({
      timeZone: 'Asia/Manila',
      graceDays: 3,
      freeze: { minDays: 7, maxDays: 90, annualCapDays: 90, feeCentavos: 10000 },
      plans: [],
    });
  });

  it('tells the model that hours differ by day and a day can be closed', () => {
    const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === 'get_gym_info');
    expect(tool?.description).toContain('a day can be closed');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=server -- assistant-gym-info`
Expected: FAIL. TypeScript reports `Expected 7 arguments, but got 8`, or the hours assertions fail.

- [ ] **Step 3: Implement**

In `server/src/assistant/assistant.service.ts`, add this import after the `GymConfigService` import:

```ts
import { OpeningHoursService, type DayHours } from '../config/opening-hours.service';
```

Add these above the `@Injectable()` line (after `ASSISTANT_COPY`):

```ts
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One day's hours as the model reads them: the weekday by name, never a number to decode. */
function dayView(day: DayHours): { day: string; opensAt: string; closesAt: string; isClosed: boolean } {
  return {
    day: WEEKDAYS[day.dayOfWeek] ?? 'Unknown',
    opensAt: day.opensAt,
    closesAt: day.closesAt,
    isClosed: day.isClosed,
  };
}
```

Add a last constructor parameter, after `private readonly gemini: GeminiGateway,`:

```ts
    private readonly openingHours: OpeningHoursService,
```

Replace the whole `case 'get_gym_info':` block with:

```ts
      case 'get_gym_info': {
        // The hours the DOOR reads (Admin → Settings, falling back to the
        // environment only when the table cannot be read) — not
        // GYM_OPEN_TIME / GYM_CLOSE_TIME, which the assistant quoted until
        // 2026-10-14 while the door had already moved on.
        const [week, today] = await Promise.all([
          this.openingHours.week(),
          this.openingHours.forDate(now),
        ]);
        return {
          hours: { today: dayView(today), week: week.map(dayView) },
          timeZone: this.gym.timeZone,
          graceDays: this.gym.graceDays,
          freeze: {
            minDays: this.gym.freezeMinDays,
            maxDays: this.gym.freezeMaxDays,
            annualCapDays: this.gym.freezeAnnualCapDays,
            feeCentavos: this.gym.freezeFeeCentavos,
          },
          plans: await this.plans.listPublic(),
        };
      }
```

In `server/src/assistant/assistant.tools.ts`, replace the `get_gym_info` description with:

```ts
    description:
      'Public information about the gym: opening hours for today and for each day of the week ' +
      '(hours can differ by day, and a day can be closed), time zone, every plan with its price ' +
      'and term, the grace period, and the freeze rules. Use this for "how much is the annual ' +
      'plan", "what time do you open", "are you open on Sunday", "how do I freeze my membership", ' +
      'or any question about policy or pricing. Prices are in Philippine pesos.',
```

In `server/src/assistant/assistant-ask.spec.ts`:
- Add the import `import type { OpeningHoursService } from '../config/opening-hours.service';`.
- In `build()`, add `gateway,` and then this as the last argument to `new AssistantService(`:

```ts
      {
        week: jest.fn().mockResolvedValue(
          Array.from({ length: 7 }, (_, dayOfWeek) => ({
            dayOfWeek,
            opensAt: '06:00',
            closesAt: '22:00',
            isClosed: false,
          })),
        ),
        forDate: jest.fn().mockResolvedValue({
          dayOfWeek: 3,
          opensAt: '06:00',
          closesAt: '22:00',
          isClosed: false,
        }),
      } as unknown as OpeningHoursService,
```

In `server/src/assistant/assistant-history.spec.ts`:
- Add `import type { OpeningHoursService } from '../config/opening-hours.service';`.
- Add `{} as unknown as OpeningHoursService,` as the last constructor argument.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=server -- src/assistant`
Expected: PASS, every suite.

- [ ] **Step 5: Commit**

```bash
git add server/src/assistant/assistant.service.ts server/src/assistant/assistant.tools.ts server/src/assistant/assistant-ask.spec.ts server/src/assistant/assistant-history.spec.ts server/src/assistant/assistant-gym-info.spec.ts
git commit -m "fix(assistant): answer opening hours from Settings, not the environment

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Database — the `AssistantSettings` table and two audit actions

**Files:**
- Create: `server/prisma/schema/assistant-settings.prisma`
- Modify: `server/prisma/schema/user.prisma` (add the back-relation beside `openingHoursUpdated`, line 148)
- Modify: `server/prisma/schema/enums.prisma` (`AuditAction`, after `WORKOUT_PLAN_SAVED`)
- Create: `server/prisma/schema/migrations/20261014000000_audit_actions_assistant/migration.sql`
- Create: `server/prisma/schema/migrations/20261014000100_assistant_settings/migration.sql`
- Create (written, **not run**): `server/test/assistant-settings-constraints.e2e-spec.ts`

**Interfaces:**
- Produces:
  - Prisma model `AssistantSettings` with `{ id: number; instructions: string; updatedById: string | null; updatedAt: Date; updatedBy: User | null }`, accessed as `prisma.assistantSettings`.
  - Enum values `ASSISTANT_INSTRUCTIONS_UPDATED` and `ASSISTANT_INSTRUCTIONS_RESET` on `AuditAction`.

- [ ] **Step 1: Write the e2e constraints spec (it pins the SQL; it is not run in this plan)**

Create `server/test/assistant-settings-constraints.e2e-spec.ts`:

```ts
import { createTestApp, type TestApp } from './support/test-app';
import { resetDatabase } from './support/db';

const ADMIN_SUPABASE_ID = '63000000-0000-4000-8000-0000000000a1';

/**
 * The assistant's editable instructions, asserted at the DATABASE
 * (feat/assistant-settings, migrations 20261014000000_audit_actions_assistant
 * and 20261014000100_assistant_settings).
 *
 * Every rule here lives only in hand-written migration SQL: a `db push` or a
 * regenerated migration would drop it silently while every service test kept
 * passing. So: the exact CHECK names and their predicates, the foreign key's
 * actions, RLS enabled with no policies, the two audit values, and one raw
 * insert per rule plus positive controls.
 *
 * Written 2026-10-14 under the owner's batch-E2E rule and not yet run against
 * Postgres: the predicate strings are what `pg_get_constraintdef` is expected
 * to print, modelled on member-notices-constraints, and are the first thing to
 * check if this suite fails on its first run.
 */
describe('CHECK constraints — assistant settings (e2e)', () => {
  let ctx: TestApp;
  let adminId: string;

  const definitionOf = async (name: string): Promise<string> => {
    const rows = await ctx.prisma.$queryRaw<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
    `;
    expect(rows).toHaveLength(1);
    return rows[0].def;
  };

  const checksOn = async (table: string): Promise<string[]> => {
    const rows = await ctx.prisma.$queryRawUnsafe<Array<{ conname: string }>>(
      `SELECT conname FROM pg_constraint WHERE conrelid = '"${table}"'::regclass AND contype = 'c'`,
    );
    return rows.map((row) => row.conname).sort();
  };

  /** One row with every column valid; `over` is raw SQL per column. */
  const insert = (over: Record<string, string> = {}): Promise<number> => {
    const columns: Record<string, string> = {
      id: '1',
      instructions: `'Be brief.'`,
      '"updatedById"': `'${adminId}'`,
      '"updatedAt"': 'CURRENT_TIMESTAMP',
      ...over,
    };
    return ctx.prisma.$executeRawUnsafe(
      `INSERT INTO "AssistantSettings" (${Object.keys(columns).join(', ')})
       VALUES (${Object.values(columns).join(', ')})`,
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp();
    await resetDatabase(ctx.prisma);
    await ctx.fixture.tokenFor('ADMIN', { supabaseId: ADMIN_SUPABASE_ID });
    adminId = await ctx.fixture.userIdFor(ADMIN_SUPABASE_ID);
  });

  afterEach(async () => {
    await ctx.prisma.$executeRawUnsafe('DELETE FROM "AssistantSettings"');
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('presence', () => {
    it('names exactly the CHECKs the migration wrote', async () => {
      expect(await checksOn('AssistantSettings')).toEqual([
        'AssistantSettings_instructions_sane',
        'AssistantSettings_single_row',
      ]);
    });

    it('asserts each PREDICATE, not just the name', async () => {
      expect(await definitionOf('AssistantSettings_single_row')).toBe('CHECK ((id = 1))');
      expect(await definitionOf('AssistantSettings_instructions_sane')).toBe(
        "CHECK (((char_length(btrim(instructions, ' \t\r\n'::text)) >= 1) AND (char_length(instructions) <= 6000)))",
      );
    });

    /** 'n' = SET NULL on delete, 'c' = CASCADE on update — the GymHours pattern. */
    it('forgets the editor rather than losing the instructions', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ conname: string; confdeltype: string; confupdtype: string }>
      >`
        SELECT conname, confdeltype::text AS confdeltype, confupdtype::text AS confupdtype
          FROM pg_constraint
         WHERE contype = 'f' AND conrelid = '"AssistantSettings"'::regclass
      `;
      expect(rows).toEqual([
        { conname: 'AssistantSettings_updatedById_fkey', confdeltype: 'n', confupdtype: 'c' },
      ]);
    });

    it('locks the table with row-level security and no policies', async () => {
      const rows = await ctx.prisma.$queryRaw<
        Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
      >`
        SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'AssistantSettings'
      `;
      expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: false }]);

      const [policies] = await ctx.prisma.$queryRaw<Array<{ count: number }>>`
        SELECT count(*)::int AS count FROM pg_policies WHERE tablename = 'AssistantSettings'
      `;
      expect(policies.count).toBe(0);
    });

    it('adds the two assistant audit actions', async () => {
      const rows = await ctx.prisma.$queryRaw<Array<{ value: string }>>`
        SELECT unnest(enum_range(NULL::"AuditAction"))::text AS value
      `;
      expect(rows.map((row) => row.value)).toEqual(
        expect.arrayContaining(['ASSISTANT_INSTRUCTIONS_UPDATED', 'ASSISTANT_INSTRUCTIONS_RESET']),
      );
    });
  });

  describe('enforcement', () => {
    it('accepts a valid row (positive control)', async () => {
      await expect(insert()).resolves.toBe(1);
    });

    it('accepts a row whose editor is gone', async () => {
      await expect(insert({ '"updatedById"': 'NULL' })).resolves.toBe(1);
    });

    it('refuses a second row', async () => {
      await insert();
      await expect(insert({ id: '2' })).rejects.toThrow(/AssistantSettings_single_row/);
    });

    it('refuses blank instructions, tabs and line breaks included', async () => {
      await expect(insert({ instructions: `E' \\t\\r\\n '` })).rejects.toThrow(
        /AssistantSettings_instructions_sane/,
      );
    });

    it('accepts 6,000 characters and refuses 6,001', async () => {
      await expect(insert({ instructions: `repeat('a', 6001)` })).rejects.toThrow(
        /AssistantSettings_instructions_sane/,
      );
      await expect(insert({ instructions: `repeat('a', 6000)` })).resolves.toBe(1);
    });
  });
});
```

- [ ] **Step 2: Write the schema**

Create `server/prisma/schema/assistant-settings.prisma`:

```prisma
/// The member assistant's editable instructions (feat/assistant-settings,
/// 2026-10-14). ONE ROW OR NONE.
///
/// No row means the built-in default in server/src/assistant/assistant-prompt.ts;
/// "Reset to default" deletes the row. The locked safety rules are never stored
/// here — code appends them to whatever this holds, after it, so no edit can
/// remove them.
///
/// The CHECKs (single row; 1–6000 characters, never blank) live only in
/// migration 20261014000100_assistant_settings — Prisma cannot represent them.
model AssistantSettings {
  /// Always 1. A second row would leave "which instructions are live" to row order.
  id           Int      @id @default(1)
  instructions String
  updatedById  String?  @db.Uuid
  updatedAt    DateTime @updatedAt @db.Timestamptz(3)

  updatedBy User? @relation("AssistantSettingsUpdatedBy", fields: [updatedById], references: [id], onDelete: SetNull)
}
```

In `server/prisma/schema/user.prisma`, add directly below the `openingHoursUpdated` line (line 148), with the same alignment:

```prisma
  assistantSettingsUpdated AssistantSettings[] @relation("AssistantSettingsUpdatedBy")
```

In `server/prisma/schema/enums.prisma`, in `enum AuditAction`, add this after `WORKOUT_PLAN_SAVED`:

```prisma

  // ── AI assistant settings (feat/assistant-settings) ──
  // An admin saving new assistant instructions ({ before, after, wasDefault }),
  // and putting the built-in instructions back ({ before }).
  ASSISTANT_INSTRUCTIONS_UPDATED
  ASSISTANT_INSTRUCTIONS_RESET
```

- [ ] **Step 3: Write the two migrations**

Create `server/prisma/schema/migrations/20261014000000_audit_actions_assistant/migration.sql`:

```sql
-- AI assistant settings (feat/assistant-settings): two audit actions.
--
-- ALONE ON PURPOSE (see 20260922000000_*): a value added by ALTER TYPE ... ADD VALUE
-- cannot be used in the transaction that adds it, and Prisma runs each file in one.
--
--   ASSISTANT_INSTRUCTIONS_UPDATED  an admin saved new assistant instructions
--   ASSISTANT_INSTRUCTIONS_RESET    an admin put the built-in instructions back
ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_INSTRUCTIONS_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'ASSISTANT_INSTRUCTIONS_RESET';
```

Create `server/prisma/schema/migrations/20261014000100_assistant_settings/migration.sql`:

```sql
-- The member assistant's editable instructions (feat/assistant-settings, 2026-10-14).
--
-- Hand-written: prisma migrate dev refuses on the shared dev DB (checksum drift).
-- ADDITIVE ONLY: one new table. main's code never reads it, so it keeps running
-- against this schema during the deploy window (migrate deploy runs first).
--
-- ONE ROW OR NONE. No row means the built-in default in
-- server/src/assistant/assistant-prompt.ts; "Reset to default" deletes the row.
-- The locked safety rules are never stored: code appends them to whatever is here.
--
-- Every CHECK below lives ONLY here — Prisma cannot represent them — so
-- test/assistant-settings-constraints.e2e-spec.ts asserts each name AND predicate.

CREATE TABLE "AssistantSettings" (
    "id"           INTEGER        NOT NULL DEFAULT 1,
    "instructions" TEXT           NOT NULL,
    "updatedById"  UUID,
    "updatedAt"    TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AssistantSettings_pkey" PRIMARY KEY ("id")
);

-- SET NULL, like GymHours: the instructions outlive the account that last saved them.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One row, ever.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_single_row"
    CHECK ("id" = 1);

-- Never blank, never longer than the editor allows. A blank row would hand the model
-- the safety rules alone, with no idea which gym it works for. The trim names tabs
-- and line breaks too: bare btrim() strips spaces only
-- (20261001000100_constraint_floor_fixes). char_length counts characters, not
-- bytes, so an emoji is one — the same count the DTO and the editor use.
ALTER TABLE "AssistantSettings" ADD CONSTRAINT "AssistantSettings_instructions_sane"
    CHECK (
      char_length(btrim("instructions", E' \t\r\n')) >= 1
      AND char_length("instructions") <= 6000
    );

-- Lock it like every other table (see 20261011000000_member_notices). Supabase's
-- default grants give `anon` and `authenticated` full DML across public; the
-- browser's only door is NestJS. ENABLE (not FORCE) leaves the server's BYPASSRLS
-- role unaffected.
ALTER TABLE "AssistantSettings" ENABLE ROW LEVEL SECURITY;

-- Guarded: `anon` and `authenticated` do not exist in the plain Postgres the e2e
-- harness builds from these migrations.
DO $rls$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON "AssistantSettings" FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON "AssistantSettings" FROM authenticated';
  END IF;
END
$rls$;
```

- [ ] **Step 4: Validate and regenerate the client**

Run, from `server/`:

```bash
DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npx prisma validate
DATABASE_URL="postgresql://x:x@localhost:5432/x" DIRECT_URL="postgresql://x:x@localhost:5432/x" npx prisma generate
```

Expected: `The schemas at prisma\schema are valid 🚀`, then `✔ Generated Prisma Client`.

Then, from the worktree root: `npm run typecheck --workspace=server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/prisma/schema/assistant-settings.prisma server/prisma/schema/user.prisma server/prisma/schema/enums.prisma server/prisma/schema/migrations/20261014000000_audit_actions_assistant server/prisma/schema/migrations/20261014000100_assistant_settings server/test/assistant-settings-constraints.e2e-spec.ts
git commit -m "feat(assistant): AssistantSettings table and its two audit actions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `AssistantSettingsService` — read with fallback, save, reset, audit

**Files:**
- Create: `server/src/assistant/assistant-settings.service.ts`
- Test (create): `server/src/assistant/assistant-settings.service.spec.ts`

**Interfaces:**
- Consumes:
  - `prisma.assistantSettings`, from Task 3.
  - `DEFAULT_ASSISTANT_INSTRUCTIONS` and `composeSystemPrompt`, from Task 1.
  - `AuditService.record(input)`, from `server/src/audit/audit.service.ts`. It never throws.
  - `GymConfigService.timeZone`.
- Produces:
  - `export interface AssistantInstructions { text: string; isDefault: boolean; updatedAt: Date | null; updatedByName: string | null }`
  - `class AssistantSettingsService`, constructed as `(prisma: PrismaService, gym: GymConfigService, audit: AuditService)`, with these methods:
    - `instructions(): Promise<AssistantInstructions>`
    - `systemPrompt(): Promise<string>`
    - `invalidate(): void`
    - `save(text: string, actorId: string, actorRole: Role): Promise<AssistantInstructions>`
    - `reset(actorId: string, actorRole: Role): Promise<AssistantInstructions>`

- [ ] **Step 1: Write the failing test**

Create `server/src/assistant/assistant-settings.service.spec.ts`:

```ts
import { Logger } from '@nestjs/common';
import { AssistantSettingsService } from './assistant-settings.service';
import { assistantSafetyRules, DEFAULT_ASSISTANT_INSTRUCTIONS } from './assistant-prompt';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';

const ADMIN = '11111111-1111-4111-8111-111111111111';
const SAVED_AT = new Date('2026-10-14T03:00:00.000Z');

const row = (instructions: string) => ({
  id: 1,
  instructions,
  updatedById: ADMIN,
  updatedAt: SAVED_AT,
  updatedBy: { firstName: 'Ana', lastName: 'Cruz' },
});

describe('AssistantSettingsService', () => {
  const findUnique = jest.fn();
  const upsert = jest.fn();
  const deleteMany = jest.fn();
  const record = jest.fn();

  const prisma = { assistantSettings: { findUnique, upsert, deleteMany } } as unknown as PrismaService;
  const audit = { record } as unknown as AuditService;
  const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
  const build = (): AssistantSettingsService => new AssistantSettingsService(prisma, gym, audit);

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-14T04:00:00.000Z') });
    for (const fn of [findUnique, upsert, deleteMany, record]) fn.mockReset();
    upsert.mockResolvedValue({});
    record.mockResolvedValue(undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('instructions()', () => {
    it('is the built-in default when nothing is saved', async () => {
      findUnique.mockResolvedValue(null);

      await expect(build().instructions()).resolves.toEqual({
        text: DEFAULT_ASSISTANT_INSTRUCTIONS,
        isDefault: true,
        updatedAt: null,
        updatedByName: null,
      });
    });

    it('is the saved text, with who saved it and when', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));

      await expect(build().instructions()).resolves.toEqual({
        text: 'Be brief.',
        isDefault: false,
        updatedAt: SAVED_AT,
        updatedByName: 'Ana Cruz',
      });
      expect(findUnique).toHaveBeenCalledWith({
        where: { id: 1 },
        include: { updatedBy: { select: { firstName: true, lastName: true } } },
      });
    });

    it('names nobody when the editor account is gone', async () => {
      findUnique.mockResolvedValue({ ...row('Be brief.'), updatedById: null, updatedBy: null });

      expect((await build().instructions()).updatedByName).toBeNull();
    });

    /**
     * A database problem must never leave a member without an assistant —
     * and must not pin the default for a minute either: the next question
     * tries the table again.
     */
    it('falls back to the default when the read fails, and retries next time', async () => {
      findUnique
        .mockRejectedValueOnce(new Error('connection terminated'))
        .mockResolvedValueOnce(row('Be brief.'));
      const service = build();

      expect((await service.instructions()).isDefault).toBe(true);
      expect((await service.instructions()).text).toBe('Be brief.');
      expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it('reads the table once a minute, not once a question', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));
      const service = build();

      await service.instructions();
      await service.instructions();
      expect(findUnique).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(60_001);
      await service.instructions();
      expect(findUnique).toHaveBeenCalledTimes(2);
    });
  });

  describe('systemPrompt()', () => {
    it('is the saved instructions followed by the locked safety rules', async () => {
      findUnique.mockResolvedValue(row('Be brief.'));

      const prompt = await build().systemPrompt();

      expect(prompt.startsWith('Be brief.')).toBe(true);
      expect(prompt.endsWith(assistantSafetyRules('Asia/Manila'))).toBe(true);
    });
  });

  describe('save()', () => {
    it('writes row 1 with the editor, then serves the new text at once', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      const result = await build().save('Be brief.', ADMIN, 'ADMIN');

      expect(upsert).toHaveBeenCalledWith({
        where: { id: 1 },
        create: { id: 1, instructions: 'Be brief.', updatedById: ADMIN },
        update: { instructions: 'Be brief.', updatedById: ADMIN },
      });
      expect(result).toMatchObject({ text: 'Be brief.', isDefault: false });
    });

    it('trims what it stores', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      await build().save('\n  Be brief.  \n', ADMIN, 'ADMIN');

      expect(upsert).toHaveBeenCalledWith(
        expect.objectContaining({ update: { instructions: 'Be brief.', updatedById: ADMIN } }),
      );
    });

    it('audits the before and the after', async () => {
      findUnique.mockResolvedValueOnce(row('Old.')).mockResolvedValueOnce(row('Newer.'));

      await build().save('Newer.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith({
        action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
        actorId: ADMIN,
        actorRole: 'ADMIN',
        subjectType: 'AssistantSettings',
        subjectLabel: '4 → 6 characters',
        details: { before: 'Old.', after: 'Newer.', wasDefault: false },
      });
    });

    it('audits replacing the built-in default, and says so', async () => {
      findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row('Be brief.'));

      await build().save('Be brief.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
          details: { before: DEFAULT_ASSISTANT_INSTRUCTIONS, after: 'Be brief.', wasDefault: true },
        }),
      );
    });

    it('writes no audit entry when nothing changed', async () => {
      findUnique.mockResolvedValue(row('Same.'));

      await build().save('  Same.\n', ADMIN, 'ADMIN');

      expect(record).not.toHaveBeenCalled();
    });

    it('compares against the table, not a minute-old cache', async () => {
      findUnique
        .mockResolvedValueOnce(row('Cached.'))
        .mockResolvedValueOnce(row('Saved elsewhere.'))
        .mockResolvedValueOnce(row('Mine.'));
      const service = build();

      await service.instructions();
      await service.save('Mine.', ADMIN, 'ADMIN');

      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          details: { before: 'Saved elsewhere.', after: 'Mine.', wasDefault: false },
        }),
      );
    });
  });

  describe('reset()', () => {
    it('deletes the row, audits what it replaced and serves the default', async () => {
      findUnique.mockResolvedValueOnce(row('Be brief.')).mockResolvedValueOnce(null);
      deleteMany.mockResolvedValue({ count: 1 });

      const result = await build().reset(ADMIN, 'ADMIN');

      expect(deleteMany).toHaveBeenCalledWith({ where: { id: 1 } });
      expect(record).toHaveBeenCalledWith({
        action: 'ASSISTANT_INSTRUCTIONS_RESET',
        actorId: ADMIN,
        actorRole: 'ADMIN',
        subjectType: 'AssistantSettings',
        subjectLabel: 'Back to the built-in instructions',
        details: { before: 'Be brief.' },
      });
      expect(result.isDefault).toBe(true);
    });

    it('audits nothing when it was already on the default', async () => {
      findUnique.mockResolvedValue(null);
      deleteMany.mockResolvedValue({ count: 0 });

      await build().reset(ADMIN, 'ADMIN');

      expect(record).not.toHaveBeenCalled();
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test --workspace=server -- assistant-settings.service`
Expected: FAIL with `Cannot find module './assistant-settings.service'`.

- [ ] **Step 3: Implement `server/src/assistant/assistant-settings.service.ts`**

```ts
import { Injectable, Logger } from '@nestjs/common';
import type { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from '../config/gym.config';
import { composeSystemPrompt, DEFAULT_ASSISTANT_INSTRUCTIONS } from './assistant-prompt';

export interface AssistantInstructions {
  text: string;
  /** True when nothing is saved and the built-in default is in use. */
  isDefault: boolean;
  updatedAt: Date | null;
  /** Null for the default, and when the account that saved it is gone. */
  updatedByName: string | null;
}

/** The table holds one row or none (CHECK "id" = 1). */
const ROW_ID = 1;

/** As OpeningHoursService: edits are rare, and every member question reads this. */
const CACHE_MS = 60_000;

/** Characters as Postgres and class-validator count them: an emoji is one. */
const characters = (text: string): number => Array.from(text).length;

/**
 * The member assistant's editable instructions — the table first, the built-in
 * default as the floor.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A DATABASE PROBLEM NEVER LEAVES A MEMBER WITHOUT AN ASSISTANT.
 *
 * No row → the default. A read that throws → the default, logged, and NOT
 * cached, so the next question tries the table again. The safety rules are
 * appended by `composeSystemPrompt` in every case, saved text or default.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class AssistantSettingsService {
  private readonly logger = new Logger(AssistantSettingsService.name);

  private cache: { at: number; value: AssistantInstructions } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
  ) {}

  private defaults(): AssistantInstructions {
    return {
      text: DEFAULT_ASSISTANT_INSTRUCTIONS,
      isDefault: true,
      updatedAt: null,
      updatedByName: null,
    };
  }

  async instructions(): Promise<AssistantInstructions> {
    const now = Date.now();
    if (this.cache !== null && now - this.cache.at < CACHE_MS) return this.cache.value;

    let value: AssistantInstructions;
    try {
      const row = await this.prisma.assistantSettings.findUnique({
        where: { id: ROW_ID },
        include: { updatedBy: { select: { firstName: true, lastName: true } } },
      });
      value =
        row === null
          ? this.defaults()
          : {
              text: row.instructions,
              isDefault: false,
              updatedAt: row.updatedAt,
              updatedByName:
                row.updatedBy === null
                  ? null
                  : `${row.updatedBy.firstName} ${row.updatedBy.lastName}`.trim(),
            };
    } catch (caught) {
      this.logger.error(
        'Could not read the assistant instructions — using the built-in default',
        caught as Error,
      );
      return this.defaults();
    }

    this.cache = { at: now, value };
    return value;
  }

  /** What Gemini is told: the instructions, then the locked safety rules. */
  async systemPrompt(): Promise<string> {
    const { text } = await this.instructions();
    return composeSystemPrompt(text, this.gym.timeZone);
  }

  /** Called after a write, so a save takes effect on the next question. */
  invalidate(): void {
    this.cache = null;
  }

  async save(text: string, actorId: string, actorRole: Role): Promise<AssistantInstructions> {
    const instructions = text.trim();

    // A fresh read, not the cache: the audit entry must say what the table
    // held, which another admin may have changed in the last minute.
    this.invalidate();
    const before = await this.instructions();

    await this.prisma.assistantSettings.upsert({
      where: { id: ROW_ID },
      create: { id: ROW_ID, instructions, updatedById: actorId },
      update: { instructions, updatedById: actorId },
    });

    this.invalidate();
    const after = await this.instructions();

    if (before.isDefault || before.text !== instructions) {
      await this.audit.record({
        action: 'ASSISTANT_INSTRUCTIONS_UPDATED',
        actorId,
        actorRole,
        subjectType: 'AssistantSettings',
        subjectLabel: `${characters(before.text)} → ${characters(instructions)} characters`,
        details: { before: before.text, after: instructions, wasDefault: before.isDefault },
      });
    }

    return after;
  }

  async reset(actorId: string, actorRole: Role): Promise<AssistantInstructions> {
    this.invalidate();
    const before = await this.instructions();

    const { count } = await this.prisma.assistantSettings.deleteMany({ where: { id: ROW_ID } });
    this.invalidate();

    if (count > 0) {
      await this.audit.record({
        action: 'ASSISTANT_INSTRUCTIONS_RESET',
        actorId,
        actorRole,
        subjectType: 'AssistantSettings',
        subjectLabel: 'Back to the built-in instructions',
        details: { before: before.text },
      });
    }

    return this.instructions();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=server -- assistant-settings.service`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add server/src/assistant/assistant-settings.service.ts server/src/assistant/assistant-settings.service.spec.ts
git commit -m "feat(assistant): AssistantSettingsService with default fallback, cache and audit

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The assistant asks with the saved instructions; `tryDraft` for the test box

**Files:**
- Modify: `server/src/assistant/assistant.service.ts`
- Modify: `server/src/assistant/assistant.module.ts` (provide `AssistantSettingsService`)
- Modify (tests): `server/src/assistant/assistant-ask.spec.ts`, `server/src/assistant/assistant-history.spec.ts`, `server/src/assistant/assistant-gym-info.spec.ts`

**Interfaces:**
- Consumes: `AssistantSettingsService.systemPrompt(): Promise<string>` (Task 4) and `composeSystemPrompt` (Task 1).
- Produces:
  - The `AssistantService` constructor gains a 9th parameter, `settings: AssistantSettingsService`.
  - `AssistantService.tryDraft(userId: string, draftInstructions: string, question: string): Promise<{ answer: string; model: string }>`.

- [ ] **Step 1: Write the failing tests**

In `server/src/assistant/assistant-ask.spec.ts`:
- Add the imports:

```ts
import { composeSystemPrompt } from './assistant-prompt';
import type { AssistantSettingsService } from './assistant-settings.service';
```

- Declare `let settings: { systemPrompt: jest.Mock };` beside the other `let`s in the top `describe`.
- In `beforeEach`, add `settings = { systemPrompt: jest.fn().mockResolvedValue('SAVED PROMPT') };`.
- In `build()`, add `settings as unknown as AssistantSettingsService,` as the last argument, after the `OpeningHoursService` fake.
- Append these tests inside the top-level `describe('AssistantService.ask', …)`, before its closing `});`:

```ts
  describe('instructions', () => {
    it('asks with the instructions saved in Settings', async () => {
      script.get(MODELS[0])!.mockResolvedValueOnce(textReply('ok'));

      await build().ask('u1', null, QUESTION);

      expect(settings.systemPrompt).toHaveBeenCalledTimes(1);
      expect(getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({ systemInstruction: 'SAVED PROMPT' }),
      );
    });
  });

  /**
   * The admin's "Try it" box. The same rotation, tools and safety rules as a
   * member's question — but the DRAFT instructions, no history, and nothing
   * saved: a test question must not appear in anybody's conversation list.
   */
  describe('tryDraft', () => {
    it('answers with the draft plus the locked safety rules, and saves nothing', async () => {
      script.get(MODELS[0])!.mockResolvedValueOnce(textReply('We open at 6:00.'));

      const result = await build().tryDraft(
        'admin-1',
        'You are the Iron Den assistant.',
        'When do you open?',
      );

      expect(result).toEqual({ answer: 'We open at 6:00.', model: MODELS[0] });
      expect(getGenerativeModel).toHaveBeenCalledWith(
        expect.objectContaining({
          systemInstruction: composeSystemPrompt('You are the Iron Den assistant.', 'Asia/Manila'),
        }),
      );
      expect(settings.systemPrompt).not.toHaveBeenCalled();
      expect(startChat).toHaveBeenCalledWith(MODELS[0], { history: [] });
      expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled();
      expect(prisma.aiConversation.create).not.toHaveBeenCalled();
      expect(prisma.aiMessage.createMany).not.toHaveBeenCalled();
    });

    it('runs tool rounds like a real question', async () => {
      script
        .get(MODELS[0])!
        .mockResolvedValueOnce(toolReply('get_gym_info'))
        .mockResolvedValueOnce(textReply('We open at 6:00.'));

      const result = await build().tryDraft('admin-1', 'Be brief.', 'When do you open?');

      expect(result.answer).toBe('We open at 6:00.');
    });

    it('is switched off without a Gemini key', async () => {
      const caught = await failure(build(null).tryDraft('admin-1', 'Be brief.', 'Hi'));

      expect(caught).toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED' });
    });
  });
```

In `server/src/assistant/assistant-history.spec.ts` and `server/src/assistant/assistant-gym-info.spec.ts`:
- Add `import type { AssistantSettingsService } from './assistant-settings.service';`.
- Add `{} as unknown as AssistantSettingsService,` as the last constructor argument.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace=server -- src/assistant`
Expected: FAIL. TypeScript reports `Expected 8 arguments, but got 9`, or `tryDraft` is not a function.

- [ ] **Step 3: Implement**

In `server/src/assistant/assistant.service.ts`:
- Replace the Task 1 import of `composeSystemPrompt, DEFAULT_ASSISTANT_INSTRUCTIONS` with:

```ts
import { composeSystemPrompt } from './assistant-prompt';
import { AssistantSettingsService } from './assistant-settings.service';
```

- Add a last constructor parameter, after `openingHours`:

```ts
    private readonly settings: AssistantSettingsService,
```

- In `ask()`, after `this.gemini.assertEnabled(ASSISTANT_COPY);`, add:

```ts
    // Read once per question, outside the rotation: every model attempt for
    // this question is told the same thing.
    const systemInstruction = await this.settings.systemPrompt();
```

  Then change the rotate callback to:

```ts
      this.runConversation(modelName, context, userId, history, question, systemInstruction),
```

- Change the `runConversation` signature to take the prompt as its last parameter, and use it:

```ts
  private async runConversation(
    modelName: string,
    context: AttemptContext,
    userId: string,
    history: Content[],
    question: string,
    systemInstruction: string,
  ): Promise<Outcome> {
    const { deadline } = context;
    const model = context.client.getGenerativeModel({
      model: modelName,
      systemInstruction,
      tools: [{ functionDeclarations: ASSISTANT_TOOLS }],
      generationConfig: generationConfigFor(modelName),
    });
```

- Add this method directly after `ask()`:

```ts
  /**
   * One question against DRAFT instructions, for the admin's "Try it" box in
   * Settings. The same rotation, tools and safety rules as `ask` — but no
   * history, and nothing saved: a test must not land in anybody's
   * conversation list. The tools still read the CALLER's own data, so an
   * admin asking about "my membership" hears about their own (usually empty)
   * account.
   */
  async tryDraft(
    userId: string,
    draftInstructions: string,
    question: string,
  ): Promise<{ answer: string; model: string }> {
    this.gemini.assertEnabled(ASSISTANT_COPY);
    const systemInstruction = composeSystemPrompt(draftInstructions, this.gym.timeZone);

    const {
      model,
      value: outcome,
      attempts,
      startedAt,
    } = await this.gemini.rotate('assistant-draft', ASSISTANT_COPY, ASK_BUDGET_MS, (modelName, context) =>
      this.runConversation(modelName, context, userId, [], question, systemInstruction),
    );

    this.logger.log(
      `assistant draft answered model=${model} ms=${Date.now() - startedAt} ` +
        `attempts=${attempts} tools=${outcome.toolCallCount} finish=${outcome.finishReason}`,
    );
    return { answer: outcome.answer, model };
  }
```

In `server/src/assistant/assistant.module.ts`, import `AssistantSettingsService` from `./assistant-settings.service` and change `providers` to:

```ts
  providers: [AssistantService, AssistantSettingsService, MeCheckInsService],
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test --workspace=server -- src/assistant`
Expected: PASS, every suite.

Run: `npm run typecheck --workspace=server`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add server/src/assistant/assistant.service.ts server/src/assistant/assistant.module.ts server/src/assistant/assistant-ask.spec.ts server/src/assistant/assistant-history.spec.ts server/src/assistant/assistant-gym-info.spec.ts
git commit -m "feat(assistant): ask with the saved instructions; tryDraft for the Settings test box

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Admin API — `GET/PUT/DELETE /admin/assistant`, `POST /admin/assistant/test`

**Files:**
- Create: `server/src/assistant/dto/assistant-settings.dto.ts`
- Create: `server/src/assistant/admin-assistant.controller.ts`
- Modify: `server/src/assistant/assistant.module.ts` (register the controller)
- Test (create): `server/src/assistant/dto/assistant-settings.dto.spec.ts`
- Test (create): `server/src/assistant/admin-assistant.controller.spec.ts`

**Interfaces:**
- Consumes:
  - From Task 4: `AssistantSettingsService.instructions()`, `.save(text, actorId, actorRole)` and `.reset(actorId, actorRole)`.
  - From Task 5: `AssistantService.tryDraft(userId, draft, question)` and `AssistantService.enabled`.
  - From Task 1: `assistantSafetyRules`, `DEFAULT_ASSISTANT_INSTRUCTIONS` and `ASSISTANT_INSTRUCTIONS_MAX_LENGTH`.
- Produces (Task 7 mirrors this on the client):

```ts
export interface AssistantSettingsView {
  instructions: string;
  isDefault: boolean;
  defaultInstructions: string;
  safetyRules: string;
  maxLength: number;
  updatedAt: string | null; // ISO-8601
  updatedByName: string | null;
  enabled: boolean;
}
```

  The routes:
  - `GET /api/v1/admin/assistant` returns `AssistantSettingsView`.
  - `PUT /api/v1/admin/assistant` takes `{ instructions }` and returns `AssistantSettingsView`.
  - `DELETE /api/v1/admin/assistant` returns `AssistantSettingsView`.
  - `POST /api/v1/admin/assistant/test` takes `{ instructions, question }` and returns `{ answer, model }` with status 200.

- [ ] **Step 1: Write the failing DTO test**

Create `server/src/assistant/dto/assistant-settings.dto.spec.ts`:

```ts
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveAssistantInstructionsDto, TryAssistantDraftDto } from './assistant-settings.dto';

/** Validated with the global pipe's own options, so an extra key fails here as it would 400. */
function constraints(cls: new () => object, payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('SaveAssistantInstructionsDto', () => {
  it('accepts instructions and trims them', () => {
    const dto = plainToInstance(SaveAssistantInstructionsDto, { instructions: '  Be brief.\n' });
    expect(dto.instructions).toBe('Be brief.');
    expect(constraints(SaveAssistantInstructionsDto, { instructions: '  Be brief.\n' })).toEqual([]);
  });

  it('rejects blank instructions, tabs and line breaks included', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: ' \t\r\n ' })).toContain(
      'isLength',
    );
  });

  it('accepts 6,000 characters and rejects 6,001', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: 'a'.repeat(6000) })).toEqual([]);
    expect(constraints(SaveAssistantInstructionsDto, { instructions: 'a'.repeat(6001) })).toContain(
      'isLength',
    );
  });

  /** Postgres char_length and the editor's counter both count an emoji as one. */
  it('counts an emoji as one character, as the database does', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: '💪'.repeat(6000) })).toEqual(
      [],
    );
    expect(
      constraints(SaveAssistantInstructionsDto, { instructions: '💪'.repeat(6001) }),
    ).toContain('isLength');
  });

  // A missing field only: the global pipe runs enableImplicitConversion, so a
  // number arrives as its string form and is not a type error at this layer.
  it('rejects a missing field', () => {
    expect(constraints(SaveAssistantInstructionsDto, {})).toContain('isString');
  });

  it('rejects unknown keys', () => {
    expect(
      constraints(SaveAssistantInstructionsDto, { instructions: 'Be brief.', isDefault: true }),
    ).toContain('whitelistValidation');
  });
});

describe('TryAssistantDraftDto', () => {
  it('accepts a draft and a question, trimmed', () => {
    const dto = plainToInstance(TryAssistantDraftDto, {
      instructions: ' Be brief. ',
      question: ' When do you open? ',
    });
    expect(dto).toMatchObject({ instructions: 'Be brief.', question: 'When do you open?' });
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'Be brief.', question: 'Hi?' }),
    ).toEqual([]);
  });

  it('holds the draft to the same 6,000-character limit as a save', () => {
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'a'.repeat(6001), question: 'Hi?' }),
    ).toContain('isLength');
  });

  it('rejects a blank question and one over 2,000 characters', () => {
    expect(constraints(TryAssistantDraftDto, { instructions: 'x', question: '   ' })).toContain(
      'isLength',
    );
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'x', question: 'q'.repeat(2001) }),
    ).toContain('isLength');
  });
});
```

- [ ] **Step 2: Write the failing controller test**

Create `server/src/assistant/admin-assistant.controller.spec.ts`:

```ts
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import type { GymConfigService } from '../config/gym.config';
import { AdminAssistantController } from './admin-assistant.controller';
import type { AssistantSettingsService } from './assistant-settings.service';
import type { AssistantService } from './assistant.service';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
} from './assistant-prompt';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' } as AuthUser;

describe('AdminAssistantController', () => {
  const handler = (name: string): object =>
    (AdminAssistantController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));
  const classMeta = (key: string): unknown => Reflect.getMetadata(key, AdminAssistantController);

  it('serves GET, PUT and DELETE /admin/assistant and POST /admin/assistant/test', () => {
    expect(classMeta(PATH_METADATA)).toBe('admin/assistant');
    expect(meta(METHOD_METADATA, 'get')).toBe(RequestMethod.GET);
    expect(meta(METHOD_METADATA, 'save')).toBe(RequestMethod.PUT);
    expect(meta(METHOD_METADATA, 'reset')).toBe(RequestMethod.DELETE);
    expect(meta(METHOD_METADATA, 'test')).toBe(RequestMethod.POST);
    expect(meta(PATH_METADATA, 'test')).toBe('test');
  });

  /** The key ADMIN already holds, unused until now. Hiding the card is not the control; this is. */
  it('gates every route on ai.admin.configure', () => {
    for (const name of ['get', 'save', 'reset', 'test']) {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBe('ai.admin.configure');
    }
  });

  it('limits Try it to 10 questions a minute, like the member assistant', () => {
    expect(meta('THROTTLER:LIMITdefault', 'test')).toBe(10);
    expect(meta('THROTTLER:TTLdefault', 'test')).toBe(60_000);
  });

  /** Try it writes nothing, so it creates nothing (200) and needs no replay protection. */
  it('answers Try it with 200 and asks for no Idempotency-Key', () => {
    expect(meta(HTTP_CODE_METADATA, 'test')).toBe(200);
    expect(meta(IDEMPOTENT_KEY, 'test')).toBeUndefined();
  });

  describe('behaviour', () => {
    const current = {
      text: 'Be brief.',
      isDefault: false,
      updatedAt: new Date('2026-10-14T03:00:00.000Z'),
      updatedByName: 'Ana Cruz',
    };
    const settings = { instructions: jest.fn(), save: jest.fn(), reset: jest.fn() };
    const tryDraft = jest.fn();
    const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;
    const build = (enabled = true): AdminAssistantController =>
      new AdminAssistantController(
        settings as unknown as AssistantSettingsService,
        { enabled, tryDraft } as unknown as AssistantService,
        gym,
      );

    beforeEach(() => {
      for (const fn of [settings.instructions, settings.save, settings.reset, tryDraft]) {
        fn.mockReset();
      }
      settings.instructions.mockResolvedValue(current);
      settings.save.mockResolvedValue(current);
      settings.reset.mockResolvedValue(current);
    });

    it('shows the saved text, the default, the locked rules and the limit', async () => {
      await expect(build().get()).resolves.toEqual({
        instructions: 'Be brief.',
        isDefault: false,
        defaultInstructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
        safetyRules: assistantSafetyRules('Asia/Manila'),
        maxLength: ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
        updatedAt: '2026-10-14T03:00:00.000Z',
        updatedByName: 'Ana Cruz',
        enabled: true,
      });
    });

    it('says when Gemini is switched off, and still shows the text', async () => {
      await expect(build(false).get()).resolves.toMatchObject({
        enabled: false,
        instructions: 'Be brief.',
      });
    });

    it('sends updatedAt as null for the default', async () => {
      settings.instructions.mockResolvedValue({
        text: DEFAULT_ASSISTANT_INSTRUCTIONS,
        isDefault: true,
        updatedAt: null,
        updatedByName: null,
      });
      await expect(build().get()).resolves.toMatchObject({ isDefault: true, updatedAt: null });
    });

    it('saves as the caller, then shows the result', async () => {
      await build().save(ADMIN, { instructions: 'Be brief.' });
      expect(settings.save).toHaveBeenCalledWith('Be brief.', ADMIN.id, 'ADMIN');
      expect(settings.instructions).toHaveBeenCalled();
    });

    it('resets as the caller', async () => {
      await build().reset(ADMIN);
      expect(settings.reset).toHaveBeenCalledWith(ADMIN.id, 'ADMIN');
    });

    it('runs the draft for the caller and returns the answer', async () => {
      tryDraft.mockResolvedValue({ answer: 'ok', model: 'gemini-3.1-flash-lite' });

      await expect(
        build().test(ADMIN, { instructions: 'Draft.', question: 'Hi?' }),
      ).resolves.toEqual({ answer: 'ok', model: 'gemini-3.1-flash-lite' });
      expect(tryDraft).toHaveBeenCalledWith(ADMIN.id, 'Draft.', 'Hi?');
    });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test --workspace=server -- admin-assistant assistant-settings.dto`
Expected: FAIL with `Cannot find module './admin-assistant.controller'` and `'./assistant-settings.dto'`.

- [ ] **Step 4: Implement the DTOs**

Create `server/src/assistant/dto/assistant-settings.dto.ts`:

```ts
import { IsString, Length } from 'class-validator';
import { Transform } from 'class-transformer';
import { ASSISTANT_INSTRUCTIONS_MAX_LENGTH } from '../assistant-prompt';

/**
 * Trimmed before validation, so whitespace alone is a 400 naming the field —
 * and so the length checked here is the length stored. `@Length` counts an
 * emoji as one character, which is what Postgres `char_length` and the
 * editor's counter count too.
 */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SaveAssistantInstructionsDto {
  @Transform(trim)
  @IsString()
  @Length(1, ASSISTANT_INSTRUCTIONS_MAX_LENGTH)
  instructions!: string;
}

export class TryAssistantDraftDto {
  @Transform(trim)
  @IsString()
  @Length(1, ASSISTANT_INSTRUCTIONS_MAX_LENGTH)
  instructions!: string;

  /** The member assistant's own bound (AskAssistantDto). */
  @Transform(trim)
  @IsString()
  @Length(1, 2000)
  question!: string;
}
```

- [ ] **Step 5: Implement the controller**

Create `server/src/assistant/admin-assistant.controller.ts`:

```ts
import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post, Put } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { GymConfigService } from '../config/gym.config';
import { AssistantService } from './assistant.service';
import { AssistantSettingsService } from './assistant-settings.service';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
} from './assistant-prompt';
import { SaveAssistantInstructionsDto, TryAssistantDraftDto } from './dto/assistant-settings.dto';

/** What the Settings card shows. Mirrored in client/src/lib/adminApi.ts. */
export interface AssistantSettingsView {
  instructions: string;
  isDefault: boolean;
  defaultInstructions: string;
  /** Read-only on the card: appended by code to whatever is saved. */
  safetyRules: string;
  maxLength: number;
  updatedAt: string | null;
  updatedByName: string | null;
  /** False when GEMINI_API_KEY is unset: the text still edits, Try it cannot answer. */
  enabled: boolean;
}

/**
 * The member assistant's instructions, edited from Admin → Settings
 * (feat/assistant-settings, 2026-10-14).
 *
 * Every route is behind `ai.admin.configure` — a key the catalogue has carried,
 * and ADMIN has held, since the assistant shipped, with nothing behind it
 * until now.
 */
@Controller('admin/assistant')
export class AdminAssistantController {
  constructor(
    private readonly settings: AssistantSettingsService,
    private readonly assistant: AssistantService,
    private readonly gym: GymConfigService,
  ) {}

  @Get()
  @RequirePermission('ai.admin.configure')
  async get(): Promise<AssistantSettingsView> {
    return this.view();
  }

  /** PUT: the whole text is replaced, so the editor and the table cannot half-agree. */
  @Put()
  @RequirePermission('ai.admin.configure')
  async save(
    @CurrentUser() user: AuthUser,
    @Body() dto: SaveAssistantInstructionsDto,
  ): Promise<AssistantSettingsView> {
    await this.settings.save(dto.instructions, user.id, user.role);
    return this.view();
  }

  @Delete()
  @RequirePermission('ai.admin.configure')
  async reset(@CurrentUser() user: AuthUser): Promise<AssistantSettingsView> {
    await this.settings.reset(user.id, user.role);
    return this.view();
  }

  /**
   * Try the UNSAVED draft. Spends the same free Gemini quota members use, so
   * it carries the member assistant's own limit.
   */
  @Post('test')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('ai.admin.configure')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async test(
    @CurrentUser() user: AuthUser,
    @Body() dto: TryAssistantDraftDto,
  ): Promise<{ answer: string; model: string }> {
    return this.assistant.tryDraft(user.id, dto.instructions, dto.question);
  }

  private async view(): Promise<AssistantSettingsView> {
    const current = await this.settings.instructions();
    return {
      instructions: current.text,
      isDefault: current.isDefault,
      defaultInstructions: DEFAULT_ASSISTANT_INSTRUCTIONS,
      safetyRules: assistantSafetyRules(this.gym.timeZone),
      maxLength: ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
      updatedAt: current.updatedAt === null ? null : current.updatedAt.toISOString(),
      updatedByName: current.updatedByName,
      enabled: this.assistant.enabled,
    };
  }
}
```

In `server/src/assistant/assistant.module.ts`, import `AdminAssistantController` from `./admin-assistant.controller` and change `controllers` to:

```ts
  controllers: [AssistantController, AdminAssistantController],
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace=server -- src/assistant`
Expected: PASS, every suite, including the two new ones.

Run: `npm run typecheck --workspace=server`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/assistant/dto/assistant-settings.dto.ts server/src/assistant/dto/assistant-settings.dto.spec.ts server/src/assistant/admin-assistant.controller.ts server/src/assistant/admin-assistant.controller.spec.ts server/src/assistant/assistant.module.ts
git commit -m "feat(assistant): admin routes to read, save, reset and try the instructions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Client plumbing — API wrappers, audit labels, helpers, shared reply renderer

**Files:**
- Modify: `client/src/lib/adminApi.ts` (types near `DayHours`, ~line 425; the `AuditAction` union, ~line 646; wrappers beside `replaceHours`, ~line 1344)
- Modify: `client/src/lib/adminApi.test.ts` (append a describe)
- Modify: `client/src/app/admin/audit/page.tsx` (the label map, ~line 62; the tone map, ~line 126)
- Create: `client/src/lib/assistantSettings.ts`
- Test (create): `client/src/lib/assistantSettings.test.ts`
- Create: `client/src/components/assistant/ReplyBody.tsx` (moved out of the portal page)
- Modify: `client/src/app/portal/assistant/page.tsx` (import `ReplyBody` instead of defining it, lines 43–98)

**Interfaces:**
- Consumes: the Task 6 HTTP routes and `AssistantSettingsView` shape.
- Produces:
  - `AssistantSettingsView` and `AssistantDraftAnswer` (`{ answer: string; model: string }`), exported from `@/lib/adminApi`.
  - `adminApi.assistantSettings()`, `adminApi.saveAssistantInstructions(instructions)`, `adminApi.resetAssistantInstructions()` and `adminApi.tryAssistantDraft(instructions, question)`.
  - From `@/lib/assistantSettings`:
    - `characterCount(text): number`
    - `checkInstructions(draft, saved, maxLength): InstructionsCheck`, where `InstructionsCheck` is `{ length; blank; tooLong; dirty; canSave }`
    - `counterLabel(length, maxLength): string`
    - `editedLabel(view): string`
  - `ReplyBody({ text })`, exported from `@/components/assistant/ReplyBody`.

- [ ] **Step 1: Write the failing tests**

Append to `client/src/lib/adminApi.test.ts`:

```ts
describe('adminApi — assistant settings', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('assistantSettings() reads /admin/assistant', async () => {
    await adminApi.assistantSettings();
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant');
  });

  it('saveAssistantInstructions() PUTs the whole text', async () => {
    await adminApi.saveAssistantInstructions('Be brief.');
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant', {
      method: 'PUT',
      body: JSON.stringify({ instructions: 'Be brief.' }),
    });
  });

  it('resetAssistantInstructions() DELETEs', async () => {
    await adminApi.resetAssistantInstructions();
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant', { method: 'DELETE' });
  });

  it('tryAssistantDraft() POSTs the draft and the question', async () => {
    await adminApi.tryAssistantDraft('Be brief.', 'When do you open?');
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant/test', {
      method: 'POST',
      body: JSON.stringify({ instructions: 'Be brief.', question: 'When do you open?' }),
    });
  });
});
```

Create `client/src/lib/assistantSettings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { characterCount, checkInstructions, counterLabel, editedLabel } from './assistantSettings';

describe('checkInstructions', () => {
  it('cannot save an unchanged draft', () => {
    expect(checkInstructions('Be brief.', 'Be brief.', 6000)).toMatchObject({
      dirty: false,
      canSave: false,
    });
  });

  it('treats whitespace at the ends as no change, because the server trims', () => {
    expect(checkInstructions('  Be brief.\n', 'Be brief.', 6000).dirty).toBe(false);
  });

  it('can save a real change', () => {
    expect(checkInstructions('Be very brief.', 'Be brief.', 6000)).toMatchObject({
      dirty: true,
      blank: false,
      tooLong: false,
      canSave: true,
    });
  });

  it('cannot save a blank draft', () => {
    expect(checkInstructions(' \n\t ', 'Be brief.', 6000)).toMatchObject({
      blank: true,
      canSave: false,
    });
  });

  it('allows exactly the limit and blocks one character over', () => {
    expect(checkInstructions('a'.repeat(6000), '', 6000).canSave).toBe(true);
    expect(checkInstructions('a'.repeat(6001), '', 6000)).toMatchObject({
      tooLong: true,
      canSave: false,
    });
  });

  it('counts an emoji as one character, as the server does', () => {
    expect(characterCount('💪💪💪')).toBe(3);
    expect(checkInstructions('💪'.repeat(6000), '', 6000).canSave).toBe(true);
  });
});

describe('counterLabel', () => {
  it('groups thousands', () => {
    expect(counterLabel(1234, 6000)).toBe('1,234 / 6,000');
  });
});

describe('editedLabel', () => {
  it('says when the built-in default is in use', () => {
    expect(editedLabel({ isDefault: true, updatedAt: null, updatedByName: null })).toBe(
      'Built-in default',
    );
  });

  it('names the editor and the gym-local date', () => {
    expect(
      editedLabel({
        isDefault: false,
        updatedAt: '2026-10-14T03:00:00.000Z',
        updatedByName: 'Ana Cruz',
      }),
    ).toMatch(/^Edited by Ana Cruz · .*14.*2026$/);
  });

  it('still reads when the editor account is gone', () => {
    expect(
      editedLabel({ isDefault: false, updatedAt: '2026-10-14T03:00:00.000Z', updatedByName: null }),
    ).toMatch(/^Edited by a former staff account · /);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test --workspace=client -- src/lib/adminApi.test.ts src/lib/assistantSettings.test.ts`
Expected: FAIL. `adminApi.assistantSettings is not a function`, and `Failed to resolve import "./assistantSettings"`.

- [ ] **Step 3: Implement the API wrappers and types**

In `client/src/lib/adminApi.ts`, add this directly after the `DayHours` interface:

```ts
/** Mirrors `AssistantSettingsView` in `server/src/assistant/admin-assistant.controller.ts`. */
export interface AssistantSettingsView {
  instructions: string;
  isDefault: boolean;
  defaultInstructions: string;
  /** Read-only: the server appends these to whatever is saved. */
  safetyRules: string;
  maxLength: number;
  /** ISO-8601, or null on the built-in default. */
  updatedAt: string | null;
  updatedByName: string | null;
  /** False when the server has no Gemini key: editing works, Try it cannot answer. */
  enabled: boolean;
}

export interface AssistantDraftAnswer {
  answer: string;
  model: string;
}
```

In the `AuditAction` union, change the last member `| 'WORKOUT_PLAN_SAVED';` to:

```ts
    | 'WORKOUT_PLAN_SAVED'
    // ── AI assistant settings ── an admin saving new instructions
    // ({ before, after, wasDefault }) or putting the built-in ones back.
    | 'ASSISTANT_INSTRUCTIONS_UPDATED'
    | 'ASSISTANT_INSTRUCTIONS_RESET';
```

Directly after the `replaceHours` wrapper, add:

```ts
  assistantSettings: (): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant'),

  saveAssistantInstructions: (instructions: string): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant', {
      method: 'PUT',
      body: JSON.stringify({ instructions }),
    }),

  resetAssistantInstructions: (): Promise<AssistantSettingsView> =>
    apiFetch<AssistantSettingsView>('/admin/assistant', { method: 'DELETE' }),

  /** Runs the UNSAVED draft. Spends the shared Gemini quota; 10 a minute. */
  tryAssistantDraft: (instructions: string, question: string): Promise<AssistantDraftAnswer> =>
    apiFetch<AssistantDraftAnswer>('/admin/assistant/test', {
      method: 'POST',
      body: JSON.stringify({ instructions, question }),
    }),
```

In `client/src/app/admin/audit/page.tsx`:
- In the label map, after `WORKOUT_PLAN_SAVED: 'Workout plan saved',`, add:

```ts
  ASSISTANT_INSTRUCTIONS_UPDATED: 'Assistant instructions edited',
  ASSISTANT_INSTRUCTIONS_RESET: 'Assistant instructions reset',
```

- In the tone map, after `WORKOUT_PLAN_SAVED: 'neutral',`, add:

```ts
  // What the member assistant is told: an owner decision, routine like a plan edit.
  ASSISTANT_INSTRUCTIONS_UPDATED: 'neutral',
  ASSISTANT_INSTRUCTIONS_RESET: 'neutral',
```

- [ ] **Step 4: Implement the helpers**

Create `client/src/lib/assistantSettings.ts`:

```ts
import { formatGymTime, GYM_TIMEZONE } from './gymTime';
import type { AssistantSettingsView } from './adminApi';

/**
 * Characters as the server counts them: code points, so an emoji is one —
 * the count class-validator's `@Length` and Postgres `char_length` use. A
 * plain `.length` would count it as two and block a valid save early.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

export interface InstructionsCheck {
  /** Characters after trimming — what the server will store. */
  length: number;
  blank: boolean;
  tooLong: boolean;
  /** Differs from what is saved, ignoring whitespace at the ends (the server trims). */
  dirty: boolean;
  canSave: boolean;
}

export function checkInstructions(draft: string, saved: string, maxLength: number): InstructionsCheck {
  const trimmed = draft.trim();
  const length = characterCount(trimmed);
  const blank = length === 0;
  const tooLong = length > maxLength;
  const dirty = trimmed !== saved.trim();
  return { length, blank, tooLong, dirty, canSave: dirty && !blank && !tooLong };
}

export function counterLabel(length: number, maxLength: number): string {
  return `${length.toLocaleString('en-US')} / ${maxLength.toLocaleString('en-US')}`;
}

export function editedLabel(
  view: Pick<AssistantSettingsView, 'isDefault' | 'updatedAt' | 'updatedByName'>,
): string {
  if (view.isDefault) return 'Built-in default';
  const who = view.updatedByName ?? 'a former staff account';
  if (view.updatedAt === null) return `Edited by ${who}`;
  const when = formatGymTime(view.updatedAt, GYM_TIMEZONE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `Edited by ${who} · ${when}`;
}
```

- [ ] **Step 5: Move `ReplyBody` into a shared component**

Create `client/src/components/assistant/ReplyBody.tsx` containing:
- the `import { formatReply } from '@/lib/assistant/formatReply';` line;
- the doc comment and the `ReplyBody` function from `client/src/app/portal/assistant/page.tsx` (lines 43–98), moved verbatim, with `function ReplyBody` changed to `export function ReplyBody`.

In `client/src/app/portal/assistant/page.tsx`:
- Delete those lines.
- Replace the `formatReply` import (line 14) with `import { ReplyBody } from '@/components/assistant/ReplyBody';`.
- Make sure `formatReply` is not used anywhere else in the page; if it is, keep its import.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test --workspace=client`
Expected: PASS, every file, including the two new describes.

- [ ] **Step 7: Commit**

```bash
git add client/src/lib/adminApi.ts client/src/lib/adminApi.test.ts client/src/app/admin/audit/page.tsx client/src/lib/assistantSettings.ts client/src/lib/assistantSettings.test.ts client/src/components/assistant/ReplyBody.tsx client/src/app/portal/assistant/page.tsx
git commit -m "feat(admin): assistant settings API wrappers, helpers and audit labels

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The "AI assistant" card on Admin → Settings

**Files:**
- Create: `client/src/components/admin/AssistantSettingsCard.tsx`
- Modify: `client/src/app/admin/settings/page.tsx` (import; mount below `<OpeningHoursCard …/>`, ~line 82)

**Interfaces:**
- Consumes:
  - From Task 7: `adminApi.assistantSettings/saveAssistantInstructions/resetAssistantInstructions/tryAssistantDraft`, `checkInstructions`, `counterLabel`, `editedLabel` and `ReplyBody`.
  - `PERMISSIONS.AI_ADMIN_CONFIGURE`, from `@got/shared`.
  - `usePermission`, from `@/components/rbac/MeProvider`.
  - `ConfirmDialog` props: `{ open, title, consequence, confirmLabel, cancelLabel, tone?, busy, error, onConfirm, onClose, children? }`.
  - `DataState` props: `{ loading, error, empty, emptyTitle, emptyHint?, onRetry }`.
  - `Badge` tones: `'ok' | 'warn' | 'danger' | 'info' | 'neutral'`.
- Produces: `AssistantSettingsCard()`, which takes no props. The page mounts it only for holders of `ai.admin.configure`.

- [ ] **Step 1: Create the card**

Create `client/src/components/admin/AssistantSettingsCard.tsx`:

```tsx
'use client';

import { useCallback, useState } from 'react';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { ReplyBody } from '@/components/assistant/ReplyBody';
import { adminApi } from '@/lib/adminApi';
import { checkInstructions, counterLabel, editedLabel } from '@/lib/assistantSettings';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ConfirmDialog } from './actions/ConfirmDialog';

/**
 * What the member assistant is told about the gym and how to answer
 * (feat/assistant-settings, 2026-10-14).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAFETY RULES ARE SHOWN, NOT EDITED.
 *
 * The server appends them after whatever is saved here, and they say they
 * override it — never invent a price or a date, never claim to have renewed or
 * booked anything, only the member's own data. They are on this card so the
 * admin can see what the assistant is held to, not so they can change it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Try it" runs the UNSAVED draft, so an edit can be checked before members
 * see it. It spends the same free Gemini quota members use.
 */
export function AssistantSettingsCard() {
  const query = useAdminQuery(
    useCallback(() => adminApi.assistantSettings(), []),
    'assistant-settings',
  );

  // `null` = not editing: the textarea shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);

  const view = query.data;
  const saved = view?.instructions ?? '';
  const text = draft ?? saved;
  const check = checkInstructions(text, saved, view?.maxLength ?? 6000);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.saveAssistantInstructions(text.trim());
      setDraft(null);
      query.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.resetAssistantInstructions();
      setDraft(null);
      setConfirmingReset(false);
      query.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not reset.');
    } finally {
      setBusy(false);
    }
  };

  const ask = async (): Promise<void> => {
    const trimmedQuestion = question.trim();
    if (trimmedQuestion === '' || check.blank || check.tooLong) return;

    setAsking(true);
    setReply(null);
    setReplyError(null);
    try {
      const result = await adminApi.tryAssistantDraft(text.trim(), trimmedQuestion);
      setReply(result.answer);
    } catch (caught) {
      setReplyError(caught instanceof Error ? caught.message : 'The assistant did not answer.');
    } finally {
      setAsking(false);
    }
  };

  return (
    <Card padded={false}>
      <div style={{ padding: '18px 18px 0' }}>
        <CardHead
          title="AI assistant"
          action={
            view ? (
              <Badge tone={view.isDefault ? 'neutral' : 'info'}>{editedLabel(view)}</Badge>
            ) : undefined
          }
        />
      </div>

      <DataState
        loading={query.loading}
        error={query.error}
        empty={false}
        emptyTitle="No instructions"
        onRetry={query.reload}
      >
        {view ? (
          <div style={{ display: 'grid', gap: 14, padding: '0 18px 18px' }}>
            <p className="p-muted" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
              What the member assistant is told about the gym and how to answer: its name and
              location, the tone, what it covers and how long it writes. Members see the change on
              their next question.
            </p>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Instructions</span>
              <textarea
                className="a-textarea"
                value={text}
                rows={14}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
                aria-describedby="assistant-instructions-count"
                style={{ fontFamily: 'inherit', lineHeight: 1.5 }}
              />
              <span
                id="assistant-instructions-count"
                style={{
                  fontSize: 12,
                  justifySelf: 'end',
                  color: check.tooLong || check.blank ? 'var(--p-danger)' : 'var(--p-ink2)',
                }}
              >
                {check.blank
                  ? 'Instructions cannot be empty'
                  : `${counterLabel(check.length, view.maxLength)} characters`}
              </span>
            </label>

            <div>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => setShowRules((open) => !open)}
                aria-expanded={showRules}
              >
                {showRules ? 'Hide' : 'Show'} the locked safety rules
              </button>
              {showRules ? (
                <div style={{ marginTop: 8 }}>
                  <p className="p-muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
                    Always added after your instructions, and they win any conflict. They cannot be
                    edited here.
                  </p>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      background: 'var(--p-paper2)',
                      borderRadius: 'var(--p-radius)',
                    }}
                  >
                    {view.safetyRules}
                  </pre>
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                Try it <span className="p-muted">(uses your unsaved draft)</span>
              </span>
              {view.enabled ? (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="a-input"
                      value={question}
                      maxLength={2000}
                      placeholder="What time do you open on Sunday?"
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void ask();
                      }}
                      style={{ flex: '1 1 240px' }}
                      aria-label="Test question"
                    />
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => void ask()}
                      disabled={asking || question.trim() === '' || check.blank || check.tooLong}
                    >
                      {asking ? 'Asking…' : 'Ask'}
                    </button>
                  </div>
                  {replyError !== null ? (
                    <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: 0 }}>
                      {replyError}
                    </p>
                  ) : null}
                  {reply !== null ? (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 'var(--p-radius)',
                        fontSize: 14,
                        lineHeight: 1.55,
                        background: 'var(--p-paper2)',
                      }}
                    >
                      <ReplyBody text={reply} />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="p-muted" style={{ fontSize: 13, margin: 0 }}>
                  The assistant is switched off on this server (no Gemini key), so it cannot answer
                  a test question. You can still edit and save the instructions.
                </p>
              )}
            </div>

            {error !== null ? (
              <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: 0 }}>
                {error}
              </p>
            ) : null}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => setConfirmingReset(true)}
                disabled={busy || view.isDefault}
              >
                Reset to default
              </button>
              {draft !== null && check.dirty ? (
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                  disabled={busy}
                >
                  Discard
                </button>
              ) : null}
              <button
                type="button"
                className="p-btn p-btn-gold p-btn-sm"
                onClick={() => void save()}
                disabled={busy || !check.canSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : null}
      </DataState>

      <ConfirmDialog
        open={confirmingReset}
        title="Put the built-in instructions back?"
        consequence="Your edited instructions are replaced by the original ones on members' next question. The old text stays in the audit log."
        confirmLabel="Reset to default"
        cancelLabel="Keep my instructions"
        busy={busy}
        error={error}
        onConfirm={() => void reset()}
        onClose={() => {
          if (busy) return;
          setConfirmingReset(false);
          setError(null);
        }}
      />
    </Card>
  );
}
```

- [ ] **Step 2: Mount it on the Settings page**

In `client/src/app/admin/settings/page.tsx`:
- Add the import `import { AssistantSettingsCard } from '@/components/admin/AssistantSettingsCard';` after the `OpeningHoursCard` import.
- After `const canManage = usePermission(PERMISSIONS.PLAN_MANAGE);`, add:

```tsx
  // Its own key, not plan.manage: what the assistant is told is a separate
  // owner decision from the price list. The routes check the same key.
  const canConfigureAssistant = usePermission(PERMISSIONS.AI_ADMIN_CONFIGURE);
```

- Directly after `<OpeningHoursCard canManage={canManage} />`, add:

```tsx
      {canConfigureAssistant ? <AssistantSettingsCard /> : null}
```

- [ ] **Step 3: Build the client and run its tests**

Stop any `next dev` running from this worktree first. Then, from the worktree root:

```bash
rm -rf client/.next
npm run build --workspace=shared
npm run build --workspace=client
npm run check:tailwind --workspace=client
npm test --workspace=client
```

Expected:
- `next build` completes with `✓ Compiled successfully` and no type errors.
- `check:tailwind` prints `Tailwind contained: <non-zero> utilities, no legacy collisions.`
- The client tests pass.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/admin/AssistantSettingsCard.tsx client/src/app/admin/settings/page.tsx
git commit -m "feat(admin): AI assistant card on Settings — edit, try, reset

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## After the tasks (controller, not a subagent)

Run the full production-readiness gate from `CLAUDE.md` on the committed branch:
- clean, then build shared → server (check `server/dist/main.js`) → client;
- both typechecks;
- server and client tests;
- `check:tailwind`.

Then push `feat/assistant-settings` as a branch and open a PR. It merges into `main` only on the owner's explicit "push to main".
