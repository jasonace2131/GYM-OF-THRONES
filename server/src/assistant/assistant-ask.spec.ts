import { Logger } from '@nestjs/common';
import {
  GoogleGenerativeAI,
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIFetchError,
  type Content,
} from '@google/generative-ai';
import type { ConfigService } from '@nestjs/config';
import { AssistantService } from './assistant.service';
import { GeminiGateway } from './gemini-gateway.service';
import { ASK_BUDGET_MS } from './assistant-budget';
import { generationConfigFor } from './gemini-models';
import type { ModelQuota } from './model-quota';
import { DomainException } from '../common/exceptions/domain.exception';
import type { PrismaService } from '../prisma/prisma.service';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import type { MembershipService } from '../membership/membership.service';
import type { PaymentsService } from '../payments/payments.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { PlansService } from '../catalogue/plans.service';
import type { OpeningHoursService } from '../config/opening-hours.service';
import { composeSystemPrompt } from './assistant-prompt';
import type { AssistantSettingsService } from './assistant-settings.service';

/**
 * ONLY the client class is replaced. Every error below is the SDK's own class
 * (`jest.requireActual`), so `instanceof GoogleGenerativeAIAbortError` inside
 * the service is tested against the real thing, not a look-alike.
 */
jest.mock('@google/generative-ai', () => {
  const actual =
    jest.requireActual<typeof import('@google/generative-ai')>('@google/generative-ai');
  return { ...actual, GoogleGenerativeAI: jest.fn() };
});

const MODELS = ['gemini-3.1-flash-lite', 'gemini-2.5-flash-lite', 'gemini-2.5-flash'];

/** Personal data, per the brief: the member's schedule must never be logged. */
const QUESTION = 'plan around school mon 8am-3pm SECRET-SCHEDULE-7731';

const FAKE_KEY = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';

interface FakeReply {
  response: {
    functionCalls: () => { name: string; args: object }[] | undefined;
    text: () => string;
    candidates?: { finishReason?: string }[];
    usageMetadata?: { candidatesTokenCount?: number; thoughtsTokenCount?: number };
  };
}

const textReply = (text: string, finishReason = 'STOP'): FakeReply => ({
  response: {
    functionCalls: () => undefined,
    text: () => text,
    candidates: [{ finishReason }],
    usageMetadata: { candidatesTokenCount: 321, thoughtsTokenCount: 0 },
  },
});

const toolReply = (name: string): FakeReply => ({
  response: {
    functionCalls: () => [{ name, args: {} }],
    text: () => '',
    candidates: [{ finishReason: 'STOP' }],
  },
});

const rateLimited = (): GoogleGenerativeAIFetchError =>
  new GoogleGenerativeAIFetchError(
    `Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: [429 Too Many Requests] You exceeded your current quota (key ${FAKE_KEY})`,
    429,
    'Too Many Requests',
  );

/** A 429 as Gemini really sends it: which quota, and how long to wait. */
const quotaLimited = (quotaId: string, retryDelay?: string): GoogleGenerativeAIFetchError =>
  new GoogleGenerativeAIFetchError(
    '[429 Too Many Requests] You exceeded your current quota',
    429,
    'Too Many Requests',
    [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId }],
      },
      ...(retryDelay === undefined
        ? []
        : [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }]),
    ],
  );
const dailyLimited = () => quotaLimited('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
const minuteLimited = (delay: string) =>
  quotaLimited('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', delay);

const aborted = (): GoogleGenerativeAIAbortError =>
  new GoogleGenerativeAIAbortError(
    'Request aborted when fetching https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: This operation was aborted',
  );

describe('AssistantService.ask', () => {
  /** One scripted `sendMessage` per model; an unscripted model is a test bug. */
  let script: Map<string, jest.Mock>;
  let startChat: jest.Mock;
  let getGenerativeModel: jest.Mock;
  let prisma: {
    aiConversation: { findFirst: jest.Mock; create: jest.Mock; update: jest.Mock };
    aiMessage: { findMany: jest.Mock; createMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let logs: { level: string; line: string }[];
  let settings: { systemPrompt: jest.Mock };

  /**
   * The shared Gemini gateway the service was last built with. The assistant
   * no longer owns the rotation or the ledger (feat/coach-tools refactor), so
   * the quota tests below reach them here.
   */
  let gateway: GeminiGateway;

  /** `null` = GEMINI_API_KEY unset (an explicit `undefined` would hit the default). */
  const build = (apiKey: string | null = 'configured'): AssistantService => {
    const gym = {
      openTime: '06:00',
      closeTime: '22:00',
      timeZone: 'Asia/Manila',
      graceDays: 3,
      freezeMinDays: 7,
      freezeMaxDays: 30,
      freezeAnnualCapDays: 60,
      freezeFeeCentavos: 0,
    } as unknown as GymConfigService;
    gateway = new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? (apiKey ?? undefined) : undefined),
      } as unknown as ConfigService<Env, true>,
      gym,
    );
    return new AssistantService(
      prisma as unknown as PrismaService,
      gym,
      {} as unknown as MembershipService,
      {} as unknown as PaymentsService,
      {} as unknown as MeCheckInsService,
      { listPublic: jest.fn().mockResolvedValue([]) } as unknown as PlansService,
      gateway,
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
      settings as unknown as AssistantSettingsService,
    );
  };

  const failure = async (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected ask() to fail');
      },
      (caught: unknown) => caught,
    );

  const allLogs = (): string => logs.map((entry) => entry.line).join('\n');

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-09-24T02:00:00.000Z') });

    script = new Map(MODELS.map((model) => [model, jest.fn()]));
    startChat = jest.fn();
    getGenerativeModel = jest.fn((params: { model: string }) => ({
      startChat: (chatParams: { history: Content[] }) => {
        startChat(params.model, chatParams);
        const send = script.get(params.model);
        if (send === undefined) throw new Error(`unscripted model ${params.model}`);
        return {
          sendMessage: (...args: unknown[]) => send(chatParams, ...args) as Promise<FakeReply>,
        };
      },
    }));
    (GoogleGenerativeAI as unknown as jest.Mock).mockImplementation(() => ({
      getGenerativeModel,
    }));

    prisma = {
      aiConversation: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'new-conversation' }),
        update: jest.fn().mockResolvedValue({}),
      },
      aiMessage: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    };

    settings = { systemPrompt: jest.fn().mockResolvedValue('SAVED PROMPT') };

    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push({ level, line: String(args[0]) });
      });
    }
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("answers, and passes the remaining budget as every call's timeout — tool rounds included", async () => {
    script
      .get(MODELS[0])!
      .mockImplementationOnce(() => {
        jest.advanceTimersByTime(3_000);
        return Promise.resolve(toolReply('get_gym_info'));
      })
      .mockImplementationOnce(() => {
        jest.advanceTimersByTime(2_000);
        return Promise.resolve(textReply('We open at 6:00.'));
      });

    const result = await build().ask('u1', null, QUESTION);

    expect(result).toEqual({
      conversationId: 'new-conversation',
      answer: 'We open at 6:00.',
      toolCallCount: 1,
      model: MODELS[0],
    });
    const calls = script.get(MODELS[0])!.mock.calls as [unknown, unknown, { timeout: number }][];
    expect(calls.map(([, , options]) => options.timeout)).toEqual([
      ASK_BUDGET_MS,
      ASK_BUDGET_MS - 3_000,
    ]);
  });

  it('hands every model its own generationConfigFor(model)', async () => {
    script.get(MODELS[0])!.mockRejectedValueOnce(rateLimited());
    script.get(MODELS[1])!.mockResolvedValueOnce(textReply('ok'));

    await build().ask('u1', null, QUESTION);

    const configs = getGenerativeModel.mock.calls.map(
      ([params]: [{ model: string; generationConfig: unknown }]) => [
        params.model,
        params.generationConfig,
      ],
    );
    expect(configs).toEqual([
      [MODELS[0], generationConfigFor(MODELS[0])],
      [MODELS[1], generationConfigFor(MODELS[1])],
    ]);
    expect(configs[1][1]).toMatchObject({ thinkingConfig: { thinkingBudget: 0 } });
  });

  it('rotates to the next model on a 429', async () => {
    script.get(MODELS[0])!.mockRejectedValueOnce(rateLimited());
    script.get(MODELS[1])!.mockResolvedValueOnce(textReply('Rest on Friday.'));

    const result = await build().ask('u1', null, QUESTION);

    expect(result.model).toBe(MODELS[1]);
    expect(result.answer).toBe('Rest on Friday.');
  });

  it('ends with ASSISTANT_TIMEOUT when a call is aborted, and tries no other model', async () => {
    script.get(MODELS[0])!.mockImplementationOnce(() => {
      jest.advanceTimersByTime(ASK_BUDGET_MS);
      return Promise.reject(aborted());
    });

    const caught = await failure(build().ask('u1', null, QUESTION));

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught).toMatchObject({ code: 'ASSISTANT_TIMEOUT' });
    expect((caught as DomainException).getStatus()).toBe(503);
    expect((caught as DomainException).message).toBe(
      'That answer took too long to write. Try again, or ask for a shorter plan — just the school days, for example.',
    );
    expect(script.get(MODELS[1])).not.toHaveBeenCalled();
  });

  it('stops with a timeout, not a call, when the budget runs out before a tool round', async () => {
    script.get(MODELS[0])!.mockImplementationOnce(() => {
      jest.advanceTimersByTime(ASK_BUDGET_MS);
      return Promise.resolve(toolReply('get_gym_info'));
    });

    const caught = await failure(build().ask('u1', null, QUESTION));

    expect(caught).toMatchObject({ code: 'ASSISTANT_TIMEOUT' });
    expect(script.get(MODELS[0])).toHaveBeenCalledTimes(1);
    expect(script.get(MODELS[1])).not.toHaveBeenCalled();
  });

  it('does not start another model with under 4 seconds left', async () => {
    script.get(MODELS[0])!.mockImplementationOnce(() => {
      jest.advanceTimersByTime(ASK_BUDGET_MS - 3_500);
      return Promise.reject(rateLimited());
    });

    const caught = await failure(build().ask('u1', null, QUESTION));

    expect(caught).toMatchObject({ code: 'ASSISTANT_TIMEOUT' });
    expect(script.get(MODELS[1])).not.toHaveBeenCalled();
  });

  it('gives up with ASSISTANT_BUSY when every model is rate-limited, and logs why', async () => {
    for (const model of MODELS) script.get(model)!.mockRejectedValue(rateLimited());

    const caught = await failure(build().ask('u1', null, QUESTION));

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught).toMatchObject({ code: 'ASSISTANT_BUSY' });
    expect((caught as DomainException).getStatus()).toBe(503);
    expect((caught as DomainException).message).toBe(
      'The assistant is busy right now. Please try again in a minute.',
    );

    const gaveUp = logs.find((entry) => entry.line.startsWith('assistant gave up'));
    expect(gaveUp?.line).toMatch(/^assistant gave up after 3 attempt\(s\) in \d+ ms — /);
    for (const model of MODELS) expect(gaveUp?.line).toContain(`${model} rate-limit status=429`);
    expect(gaveUp?.line).toContain('last: GoogleGenerativeAIFetchError status=429');
    // The key-shaped string in the SDK message must never reach a log.
    expect(allLogs()).not.toContain('AIza');
  });

  it('logs one line per failed attempt: model, class, status and time', async () => {
    script.get(MODELS[0])!.mockImplementationOnce(() => {
      jest.advanceTimersByTime(800);
      return Promise.reject(rateLimited());
    });
    script.get(MODELS[1])!.mockResolvedValueOnce(textReply('ok'));

    await build().ask('u1', null, QUESTION);

    expect(logs).toContainEqual({
      level: 'warn',
      line: `assistant attempt 1: ${MODELS[0]} rate-limit status=429 800ms`,
    });
  });

  it("logs the answer with counts only — never the member's own words", async () => {
    script.get(MODELS[0])!.mockImplementationOnce(() => {
      jest.advanceTimersByTime(1_200);
      return Promise.resolve(textReply('Monday:\n- Squat 3x8'));
    });

    await build().ask('u1', null, QUESTION);

    expect(logs).toContainEqual({
      level: 'log',
      line: `assistant answered model=${MODELS[0]} ms=1200 attempts=1 tools=0 finish=STOP outTokens=321 thoughts=0 quota=${MODELS[0]} 1/500 today`,
    });
    expect(allLogs()).not.toContain('SECRET-SCHEDULE');
    expect(allLogs()).not.toContain('Squat');
  });

  it('fails fast on a 400 without trying another model', async () => {
    const badRequest = new GoogleGenerativeAIFetchError(
      '[400 Bad Request] Invalid JSON payload received',
      400,
      'Bad Request',
    );
    script.get(MODELS[0])!.mockRejectedValueOnce(badRequest);

    const caught = await failure(build().ask('u1', null, QUESTION));

    expect(caught).toBe(badRequest);
    expect(script.get(MODELS[1])).not.toHaveBeenCalled();
  });

  /**
   * THE EMPTY-CONVERSATION BUG. The conversation row used to be created before
   * the model was asked, so every failed first message left an untitled-looking
   * chat with no messages in the member's history.
   */
  it('creates nothing when a first message fails', async () => {
    for (const model of MODELS) script.get(model)!.mockRejectedValue(rateLimited());

    await failure(build().ask('u1', null, QUESTION));

    expect(prisma.aiConversation.create).not.toHaveBeenCalled();
    expect(prisma.aiMessage.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('writes a new conversation and both messages in ONE nested create, 1 ms apart', async () => {
    script.get(MODELS[0])!.mockResolvedValueOnce(textReply('Here is your plan.'));

    await build().ask('u1', null, QUESTION);

    expect(prisma.aiConversation.create).toHaveBeenCalledTimes(1);
    const [args] = prisma.aiConversation.create.mock.calls[0] as [
      {
        data: {
          userId: string;
          title: string;
          messages: {
            create: { role: string; content: string; toolCallCount: number; createdAt: Date }[];
          };
        };
      },
    ];
    expect(args.data.userId).toBe('u1');
    expect(args.data.title).toBe(QUESTION.slice(0, 120));
    const [asked, answered] = args.data.messages.create;
    expect(asked).toMatchObject({ role: 'USER', content: QUESTION, toolCallCount: 0 });
    expect(answered).toMatchObject({ role: 'ASSISTANT', content: 'Here is your plan.' });
    expect(answered.createdAt.getTime() - asked.createdAt.getTime()).toBe(1);
    expect(prisma.aiMessage.createMany).not.toHaveBeenCalled();
  });

  it('appends to an existing conversation without creating one', async () => {
    prisma.aiConversation.findFirst.mockResolvedValueOnce({ id: 'c-existing' });
    script.get(MODELS[0])!.mockResolvedValueOnce(textReply('Sure.'));

    const result = await build().ask('u1', 'c-existing', QUESTION);

    expect(result.conversationId).toBe('c-existing');
    expect(prisma.aiConversation.findFirst).toHaveBeenCalledWith({
      where: { id: 'c-existing', userId: 'u1' },
      select: { id: true },
    });
    expect(prisma.aiConversation.create).not.toHaveBeenCalled();
    expect(prisma.aiMessage.createMany).toHaveBeenCalledTimes(1);
  });

  it('refuses with ASSISTANT_NOT_CONFIGURED when there is no API key', async () => {
    const caught = await failure(build(null).ask('u1', null, QUESTION));

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught).toMatchObject({ code: 'ASSISTANT_NOT_CONFIGURED' });
    expect((caught as DomainException).getStatus()).toBe(503);
    expect((caught as DomainException).message).toBe(
      'The assistant is switched off right now — the front desk can help.',
    );
    expect(prisma.aiConversation.findFirst).not.toHaveBeenCalled();
  });

  it('says so when the reply was cut off at the output cap', async () => {
    script
      .get(MODELS[0])!
      .mockResolvedValueOnce(textReply('Monday:\n- Squat 3x8\n\nTuesday:\n- Row', 'MAX_TOKENS'));

    const result = await build().ask('u1', null, QUESTION);

    expect(result.answer).toBe(
      'Monday:\n- Squat 3x8\n\nTuesday:\n- Row\n\n(That got cut off — ask me to continue.)',
    );
    expect(logs.some((e) => e.level === 'warn' && /maxOutputTokens/.test(e.line))).toBe(true);
  });

  /**
   * The SDK's ChatSession keeps the history array it is given BY REFERENCE and
   * pushes every successful round onto it. Shared across attempts, a model
   * that answered round one and then failed would leave its half-finished
   * tool exchange in the next model's history.
   */
  it('gives each model a clean copy of the history', async () => {
    script.get(MODELS[0])!.mockImplementationOnce((chat: { history: Content[] }) => {
      chat.history.push({ role: 'user', parts: [{ text: 'leaked' }] });
      return Promise.reject(rateLimited());
    });
    script.get(MODELS[1])!.mockResolvedValueOnce(textReply('ok'));

    await build().ask('u1', null, QUESTION);

    const histories = startChat.mock.calls.map(
      ([, params]: [string, { history: Content[] }]) => params.history,
    );
    expect(histories[1]).toEqual([]);
  });
  /**
   * 2026-09-25, owner: "the assistant should have a rotating quota … change the
   * agent whenever he is near to the quota". It rotated, but only after each
   * refusal, and never remembered one — see ./model-quota.
   */
  describe('quota rotation', () => {
    // The ledger now lives on the shared gateway the service was built with.
    const quotaOf = (): ModelQuota => (gateway as unknown as { quota: ModelQuota }).quota;

    it('remembers a daily limit: the next question skips that model without calling it', async () => {
      script.get(MODELS[0])!.mockRejectedValueOnce(dailyLimited());
      script.get(MODELS[1])!.mockResolvedValue(textReply('ok'));
      const service = build();

      await service.ask('u1', null, QUESTION);
      const second = await service.ask('u1', null, QUESTION);

      expect(second.model).toBe(MODELS[1]);
      expect(script.get(MODELS[0])).toHaveBeenCalledTimes(1);
      expect(allLogs()).toContain(
        'assistant skipping gemini-3.1-flash-lite (per-day until 2026-09-24T07:00:00.000Z)',
      );
    });

    it('switches away from a model that is NEAR its limit, before it refuses', async () => {
      const service = build();
      for (let i = 0; i < 14; i += 1) quotaOf().record(MODELS[0], new Date()); // 1 left this minute
      script.get(MODELS[1])!.mockResolvedValue(textReply('ok'));

      const result = await service.ask('u1', null, QUESTION);

      expect(result.model).toBe(MODELS[1]);
      expect(script.get(MODELS[0])).not.toHaveBeenCalled();
    });

    it("counts every request, tool rounds included, and logs today's use", async () => {
      script
        .get(MODELS[0])!
        .mockResolvedValueOnce(toolReply('get_gym_info'))
        .mockResolvedValueOnce(textReply('We open at 6.'));

      await build().ask('u1', null, QUESTION);

      const answered = logs.find((entry) => entry.line.startsWith('assistant answered'));
      expect(answered?.line).toContain('quota=gemini-3.1-flash-lite 2/500 today');
    });

    it('once every model is spent for the day, says when it is back — and stops calling Gemini', async () => {
      for (const model of MODELS) script.get(model)!.mockRejectedValueOnce(dailyLimited());
      const service = build();

      const first = await failure(service.ask('u1', null, QUESTION));
      const second = await failure(service.ask('u1', null, QUESTION));

      // Reset is midnight Pacific = 07:00 UTC = 3:00 PM in the gym's Manila time.
      for (const caught of [first, second]) {
        expect(caught).toMatchObject({ code: 'ASSISTANT_BUSY' });
        expect((caught as DomainException).message).toBe(
          'The assistant has reached its usage limit. It will be back at 3:00 PM.',
        );
      }
      for (const model of MODELS) expect(script.get(model)).toHaveBeenCalledTimes(1);
      expect(allLogs()).toContain('assistant gave up before trying: every model is resting');
    });

    it('a short per-minute pause still says to try again in a minute', async () => {
      for (const model of MODELS) script.get(model)!.mockRejectedValueOnce(minuteLimited('20s'));
      const service = build();

      await failure(service.ask('u1', null, QUESTION));
      const second = await failure(service.ask('u1', null, QUESTION));

      expect((second as DomainException).message).toBe(
        'The assistant is busy right now. Please try again in a minute.',
      );
      for (const model of MODELS) expect(script.get(model)).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(20_001);
      script.get(MODELS[0])!.mockResolvedValueOnce(textReply('back'));
      expect((await service.ask('u1', null, QUESTION)).model).toBe(MODELS[0]);
    });
  });
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
});
