import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import type { GymConfigService } from '../config/gym.config';
import { GeminiGateway } from '../assistant/gemini-gateway.service';
import {
  DraftGoneError,
  MEMBER_COPY,
  UnusableReplyError,
  rotateForMember,
} from './member-workout-gemini';

/**
 * How the member planner rides the shared gateway (feat/member-workouts):
 * an unusable reply rotates to the next model like an upstream fault; when
 * every model is unusable the member hears "could not use", not "busy"; a
 * cancelled draft stops the rotation dead.
 */
describe('rotateForMember', () => {
  const gateway = (apiKey: string | null = 'configured'): GeminiGateway =>
    new GeminiGateway(
      {
        get: (key: string) => (key === 'GEMINI_API_KEY' ? (apiKey ?? undefined) : undefined),
      } as unknown as ConfigService<Env, true>,
      { timeZone: 'Asia/Manila' } as unknown as GymConfigService,
    );

  const failure = (promise: Promise<unknown>): Promise<unknown> =>
    promise.then(
      () => {
        throw new Error('expected a failure');
      },
      (caught: unknown) => caught,
    );

  beforeEach(() => {
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it("rotates past an unusable reply and returns the next model's answer", async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(new UnusableReplyError('not JSON'))
      .mockResolvedValueOnce('plan');

    const result = await rotateForMember(gateway(), 'test', 10_000, attempt);

    expect(result.value).toBe('plan');
    expect(result.attempts).toBe(2);
  });

  it('says "could not use" when every model wrote something unusable', async () => {
    const attempt = jest.fn().mockRejectedValue(new UnusableReplyError('bad line'));

    const caught = await failure(rotateForMember(gateway(), 'test', 10_000, attempt));

    expect(caught).toBeInstanceOf(DomainException);
    expect(caught).toMatchObject({
      code: 'WORKOUT_PLAN_SUGGESTION_INVALID',
      message: MEMBER_COPY.unusable,
    });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("keeps the gateway's own busy copy when the last model was genuinely busy", async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(new UnusableReplyError('bad line'))
      .mockRejectedValue(Object.assign(new Error('quota exceeded'), { status: 429 }));

    const caught = await failure(rotateForMember(gateway(), 'test', 10_000, attempt));

    expect(caught).toMatchObject({ code: 'ASSISTANT_BUSY', message: MEMBER_COPY.busy });
  });

  it('answers ASSISTANT_NOT_CONFIGURED with member copy when there is no key', async () => {
    const attempt = jest.fn();
    const caught = await failure(rotateForMember(gateway(null), 'test', 10_000, attempt));
    expect(caught).toMatchObject({
      code: 'ASSISTANT_NOT_CONFIGURED',
      message: MEMBER_COPY.notConfigured,
    });
    expect(attempt).not.toHaveBeenCalled();
  });

  it('stops at once when the draft is gone — no other model is tried', async () => {
    const attempt = jest.fn().mockRejectedValue(new DraftGoneError());

    const caught = await failure(rotateForMember(gateway(), 'test', 10_000, attempt));

    expect(caught).toBeInstanceOf(DraftGoneError);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
