import { Injectable, Logger } from '@nestjs/common';
import {
  FinishReason,
  type Content,
  type EnhancedGenerateContentResponse,
  type Part,
} from '@google/generative-ai';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { OpeningHoursService, type DayHours } from '../config/opening-hours.service';
import { MembershipService } from '../membership/membership.service';
import { PaymentsService } from '../payments/payments.service';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { PlansService } from '../catalogue/plans.service';
import { accessVerdict } from '../membership/access-verdict';
import { gymToday } from '../common/time/gym-time';
import { ASSISTANT_TOOLS } from './assistant.tools';
import { composeSystemPrompt } from './assistant-prompt';
import { AssistantSettingsService } from './assistant-settings.service';
import { ASK_BUDGET_MS, BudgetExhaustedError, remainingMs } from './assistant-budget';
import { generationConfigFor } from './gemini-models';
import { GeminiGateway, type AttemptContext, type GeminiCopy } from './gemini-gateway.service';

/**
 * A hard ceiling on tool round-trips per question.
 *
 * Four tools exist and a member's question needs at most two or three. Six
 * bounds a pathological loop — the model calling the same tool repeatedly — at
 * a known cost instead of an unbounded one. Hitting it is a bug worth logging,
 * not a state to hide.
 */
const MAX_TOOL_ROUNDS = 6;

/** The last 20 turns. Long enough to follow a conversation, short enough that
 *  an old chat cannot grow into an expensive prompt without limit. */
const HISTORY_TURNS = 20;

const HANDOFF = 'I am not able to help with that one — please ask at the front desk.';
const CUT_OFF_NOTE = '(That got cut off — ask me to continue.)';

/**
 * What the member reads when the shared Gemini gateway cannot answer. The
 * gateway picks WHICH message; the words are the assistant's own.
 */
const ASSISTANT_COPY: GeminiCopy = {
  notConfigured: 'The assistant is switched off right now — the front desk can help.',
  busy: 'The assistant is busy right now. Please try again in a minute.',
  busyUntil: (at) => `The assistant has reached its usage limit. It will be back at ${at}.`,
  timeout:
    'That answer took too long to write. Try again, or ask for a shorter plan — just the school days, for example.',
};

/** One model's finished answer, plus what the success log line reports. */
interface Outcome {
  answer: string;
  toolCallCount: number;
  finishReason: string;
  outputTokens: number | null;
  thoughtTokens: number | null;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** One day's hours as the model reads them: the weekday by name, never a number to decode. */
function dayView(day: DayHours): {
  day: string;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
} {
  return {
    day: WEEKDAYS[day.dayOfWeek] ?? 'Unknown',
    opensAt: day.opensAt,
    closesAt: day.closesAt,
    isClosed: day.isClosed,
  };
}

/**
 * The member assistant.
 *
 * The Gemini machinery — model rotation, the quota ledger, the time budget's
 * give-up rules — lives in `GeminiGateway`, shared with the coach's workout
 * plan suggester because both spend the same free quota. What stays here is
 * the assistant's own: the tool loop, its four read-only tools over the
 * caller's own data, and the conversation history.
 */
@Injectable()
export class AssistantService {
  private readonly logger = new Logger(AssistantService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly payments: PaymentsService,
    private readonly checkIns: MeCheckInsService,
    private readonly plans: PlansService,
    private readonly gemini: GeminiGateway,
    private readonly openingHours: OpeningHoursService,
    private readonly settings: AssistantSettingsService,
  ) {}

  get enabled(): boolean {
    return this.gemini.enabled;
  }

  /**
   * One question, one answer.
   *
   * `userId` comes from the JWT and is closed over by every tool executor
   * below. It is never a model-supplied value, which is what makes "own data
   * only" a structural guarantee rather than a prompt instruction.
   */
  async ask(
    userId: string,
    conversationId: string | null,
    question: string,
  ): Promise<{ conversationId: string; answer: string; toolCallCount: number; model: string }> {
    this.gemini.assertEnabled(ASSISTANT_COPY);
    // Read once per question, outside the rotation: every model attempt for
    // this question is told the same thing.
    const systemInstruction = await this.settings.systemPrompt();

    // FOUND, NEVER CREATED. The conversation row used to be created here,
    // before any model was asked, so every failed first message left an empty
    // conversation in the member's history. A new one is now written only
    // once there is an answer to put in it (see `persist`).
    const existing = await this.findConversation(userId, conversationId);
    const history = existing === null ? [] : await this.loadHistory(existing.id);

    // ONE MODEL PER ATTEMPT (see GeminiGateway.rotate): nothing is written
    // until an attempt has returned an answer.
    const {
      model,
      value: outcome,
      attempts,
      startedAt,
    } = await this.gemini.rotate('assistant', ASSISTANT_COPY, ASK_BUDGET_MS, (modelName, context) =>
      this.runConversation(modelName, context, userId, history, question, systemInstruction),
    );

    // Outside the rotation on purpose: a database error while saving is not a
    // model failure, and must not send the question to the next model.
    const savedId = await this.persist(userId, existing, question, outcome);

    // Counts and lengths only. The member's question and the answer are
    // personal data — a plan built around their school timetable — and a
    // log line is kept far longer and read far more widely than the chat.
    this.logger.log(
      `assistant answered model=${model} ms=${Date.now() - startedAt} ` +
        `attempts=${attempts} tools=${outcome.toolCallCount} ` +
        `finish=${outcome.finishReason} outTokens=${outcome.outputTokens ?? '-'} ` +
        `thoughts=${outcome.thoughtTokens ?? '-'} quota=${this.gemini.describeQuota(model)}`,
    );
    return {
      conversationId: savedId,
      answer: outcome.answer,
      toolCallCount: outcome.toolCallCount,
      model,
    };
  }

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
    } = await this.gemini.rotate(
      'assistant-draft',
      ASSISTANT_COPY,
      ASK_BUDGET_MS,
      (modelName, context) =>
        this.runConversation(modelName, context, userId, [], question, systemInstruction),
    );

    this.logger.log(
      `assistant draft answered model=${model} ms=${Date.now() - startedAt} ` +
        `attempts=${attempts} tools=${outcome.toolCallCount} finish=${outcome.finishReason}`,
    );
    return { answer: outcome.answer, model };
  }

  /**
   * The tool loop, against one model.
   *
   * Every `sendMessage` — the question and each tool round — carries the
   * REMAINING budget as its timeout, so the SDK aborts it when the ask's time
   * is up rather than whenever Google or the proxy gives up.
   */
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

    // A COPY. The SDK's ChatSession keeps the array it is given by reference
    // and pushes every successful round onto it, so sharing one across
    // attempts would hand the next model this one's half-finished exchange.
    const chat = model.startChat({ history: [...history] });
    let toolCallCount = 0;
    // Every sendMessage is one request against the model's quota.
    context.countRequest();
    let reply = await chat.sendMessage(question, { timeout: remainingMs(deadline) });

    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      const calls = reply.response.functionCalls();
      if (calls === undefined || calls.length === 0) {
        return this.finish(modelName, reply.response, toolCallCount);
      }

      // Every call gets a response, in ONE message. Dropping one leaves the
      // model waiting for a result that never arrives.
      const parts: Part[] = [];
      for (const call of calls) {
        toolCallCount += 1;
        parts.push({
          functionResponse: {
            name: call.name,
            response: await this.runTool(userId, call.name),
          },
        });
      }

      // A timeout of 0 would abort at once; say what happened instead.
      const left = remainingMs(deadline);
      if (left === 0) {
        throw new BudgetExhaustedError(`no time left for tool round ${round + 1} on ${modelName}`);
      }
      context.countRequest();
      reply = await chat.sendMessage(parts, { timeout: left });
    }

    this.logger.warn(`assistant hit MAX_TOOL_ROUNDS on ${modelName}`);
    return {
      answer: 'I could not work that one out. Please ask at the front desk.',
      toolCallCount,
      finishReason: 'MAX_TOOL_ROUNDS',
      outputTokens: null,
      thoughtTokens: null,
    };
  }

  /** A reply with no tool calls left: the answer, and what the log reports. */
  private finish(
    modelName: string,
    response: EnhancedGenerateContentResponse,
    toolCallCount: number,
  ): Outcome {
    /*
     * `.text()` THROWS when the response carries no text candidate — a
     * safety-blocked reply, or an empty candidate the model sometimes
     * returns for one-word emotional messages. That throw is neither a
     * rate limit nor a 404, so it used to fall through the rotation and
     * reach the member as a bare "Internal server error" in the chat.
     *
     * A blocked reply is a NORMAL outcome for a general-purpose model
     * wired to a narrow job. The front-desk hand-off is the honest
     * answer, and rule 1 of the safety rules (assistant-prompt.ts) already promises it.
     */
    let answer: string;
    try {
      answer = response.text().trim();
    } catch {
      this.logger.warn(`model ${modelName} returned no readable text — handing off`);
      answer = '';
    }

    const finishReason = response.candidates?.[0]?.finishReason;
    // `thoughtsTokenCount` is sent by the API but missing from 0.24.1's types.
    const usage = response.usageMetadata as
      { candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined;
    const outputTokens = usage?.candidatesTokenCount ?? null;

    // A plan stopped mid-day reads as a complete plan unless it says
    // otherwise, so it says otherwise.
    if (finishReason === FinishReason.MAX_TOKENS) {
      this.logger.warn(
        `assistant reply on ${modelName} hit maxOutputTokens (outTokens=${outputTokens ?? '-'})`,
      );
      if (answer !== '') answer = `${answer}\n\n${CUT_OFF_NOTE}`;
    }

    return {
      answer: answer === '' ? HANDOFF : answer,
      toolCallCount,
      finishReason: finishReason ?? 'UNKNOWN',
      outputTokens,
      thoughtTokens: usage?.thoughtsTokenCount ?? null,
    };
  }

  /**
   * Executes one tool against the CALLER's data.
   *
   * The model's arguments are ignored entirely — every tool declares no
   * parameters, so there is nothing in a call to honour. A model that invents
   * an argument gets it discarded rather than interpreted.
   */
  private async runTool(userId: string, name: string): Promise<object> {
    try {
      return { data: await this.dispatch(userId, name) };
    } catch (caught) {
      // Logged in full server-side, reported to the model as a short string. A
      // stack trace handed to a language model is context it will try to
      // explain to a member.
      this.logger.error(`tool ${name} failed`, caught as Error);
      return { error: 'That information could not be read right now.' };
    }
  }

  private async dispatch(userId: string, name: string): Promise<unknown> {
    const now = new Date();
    const today = gymToday(now, this.gym.timeZone);

    switch (name) {
      case 'get_my_membership': {
        const subject = await this.memberships.loadSubject(userId, today);
        const verdict = accessVerdict(subject, today, {
          expiringSoonDays: this.gym.expiringSoonDays,
          graceAdmissionsMax: this.gym.graceAdmissionsMax,
        });
        return {
          hasMembership: subject.membership !== null,
          membership: subject.membership,
          canGetInToday: verdict.decision !== 'DENY',
          decision: verdict.decision,
          reason: verdict.message,
          daysRemaining: verdict.daysRemaining,
        };
      }

      case 'get_my_attendance':
        return this.checkIns.summary(userId, now);

      case 'get_my_payments': {
        // `archived: false` explicitly: archiving is a soft delete, and a
        // member asking the assistant about their own payments should see
        // the same register the console's default view shows.
        const page = await this.payments.listForMember(userId, {
          page: 1,
          limit: 10,
          archived: false,
        });
        return page.items;
      }

      case 'get_gym_info': {
        // The hours the DOOR reads (Admin → Settings, falling back to the
        // environment only when the table cannot be read) — not
        // GYM_OPEN_TIME / GYM_CLOSE_TIME, which the assistant quoted until
        // 2026-10-14 while the door had already moved on.
        const [week, todayHours] = await Promise.all([
          this.openingHours.week(),
          this.openingHours.forDate(now),
        ]);
        return {
          hours: { today: dayView(todayHours), week: week.map(dayView) },
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

      default:
        // Not reachable through the API — the model can only name tools it was
        // given — but a silent undefined here would reach a member as a
        // confidently wrong answer.
        throw new Error(`unknown tool ${name}`);
    }
  }

  /**
   * The caller's own conversation, or null — never a new row.
   *
   * Scoped to the caller, so a well-formed id belonging to somebody else
   * resolves to nothing rather than to their conversation; the question then
   * starts a new conversation of the caller's own, as it always has.
   */
  private async findConversation(
    userId: string,
    conversationId: string | null,
  ): Promise<{ id: string } | null> {
    if (conversationId === null) return null;
    return this.prisma.aiConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
  }

  /**
   * Saves one answered question and returns the conversation it belongs to.
   *
   * A NEW conversation is written in ONE nested create — the conversation and
   * both messages together — so there is never a moment, and never a failure,
   * that leaves a conversation with no messages in it. An existing one keeps
   * `record()`.
   */
  private async persist(
    userId: string,
    existing: { id: string } | null,
    question: string,
    outcome: Outcome,
  ): Promise<string> {
    if (existing !== null) {
      await this.record(existing.id, question, outcome.answer, outcome.toolCallCount);
      return existing.id;
    }

    // The same explicit, ordered timestamps `record()` uses, for the same
    // reason: `loadHistory` needs USER strictly before ASSISTANT.
    const askedAt = new Date();
    const answeredAt = new Date(askedAt.getTime() + 1);

    const created = await this.prisma.aiConversation.create({
      data: {
        userId,
        title: question.slice(0, 120),
        messages: {
          create: [
            { role: 'USER', content: question, toolCallCount: 0, createdAt: askedAt },
            {
              role: 'ASSISTANT',
              content: outcome.answer,
              toolCallCount: outcome.toolCallCount,
              createdAt: answeredAt,
            },
          ],
        },
      },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Gemini history: `user` and `model`, oldest first — and the FIRST entry
   * must be `user`, which is the invariant this whole method is shaped around.
   *
   * The `role` tiebreak is for rows that already exist: pairs written before
   * the explicit-timestamp fix share one `createdAt`, and within that tie
   * `role: 'asc'` puts ASSISTANT before USER in the DESC window — so after
   * the reverse, USER correctly comes first. Alphabetical luck, documented so
   * nobody "simplifies" it away.
   *
   * The shift() guard is for the window itself: `take` counts ROWS, so an
   * odd cut can strand an ASSISTANT reply whose question fell outside the
   * window at the head of the history. Dropping it loses nothing a model
   * needs and keeps the invariant unconditional.
   */
  private async loadHistory(conversationId: string): Promise<Content[]> {
    const rows = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: [{ createdAt: 'desc' }, { role: 'asc' }],
      take: HISTORY_TURNS,
      select: { role: true, content: true },
    });

    const history = rows.reverse().map((row) => ({
      role: row.role === 'USER' ? ('user' as const) : ('model' as const),
      parts: [{ text: row.content }],
    }));

    while (history.length > 0 && history[0]?.role !== 'user') history.shift();

    return history;
  }

  private async record(
    conversationId: string,
    question: string,
    answer: string,
    toolCallCount: number,
  ): Promise<void> {
    /*
     * EXPLICIT, ORDERED TIMESTAMPS — the absence of them broke every
     * conversation at message two.
     *
     * `createMany` wrote both rows in one statement, so both got the same
     * default `createdAt` to the millisecond. `loadHistory` orders by that
     * column, and Postgres breaks the tie however it likes — in production it
     * chose ASSISTANT-then-USER, so the reloaded history STARTED WITH A MODEL
     * TURN. Gemini rejects that outright ("first content should be with role
     * 'user'"), the 400 correctly failed fast, and the member saw a 500 on
     * every message after their first.
     */
    const askedAt = new Date();
    const answeredAt = new Date(askedAt.getTime() + 1);

    await this.prisma.$transaction([
      this.prisma.aiMessage.createMany({
        data: [
          { conversationId, role: 'USER', content: question, toolCallCount: 0, createdAt: askedAt },
          {
            conversationId,
            role: 'ASSISTANT',
            content: answer,
            toolCallCount,
            createdAt: answeredAt,
          },
        ],
      }),
      // Bumps `updatedAt`, which is what the history list sorts on.
      this.prisma.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
  }
}
