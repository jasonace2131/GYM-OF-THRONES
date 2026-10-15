import { AssistantService } from './assistant.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { MembershipService } from '../membership/membership.service';
import type { PaymentsService } from '../payments/payments.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { PlansService } from '../catalogue/plans.service';
import type { GeminiGateway } from './gemini-gateway.service';
import type { OpeningHoursService } from '../config/opening-hours.service';
import type { AssistantSettingsService } from './assistant-settings.service';

/**
 * THE REGRESSION SUITE FOR "IT ONLY RECEIVES ONE MESSAGE".
 *
 * `record()` wrote the USER/ASSISTANT pair with `createMany`, so both rows got
 * the same default `createdAt` to the millisecond. `loadHistory()` ordered by
 * that column alone, Postgres broke the tie however it liked — production
 * chose ASSISTANT-then-USER — and the reloaded history began with a `model`
 * turn. Gemini rejects that with a 400, the 400 correctly fails fast, and the
 * member saw "Internal server error" on every message after their first.
 *
 * Message one always worked because a new conversation has no history, which
 * is exactly why every smoke test passed while every real conversation broke.
 */
describe('AssistantService history', () => {
  const findMany = jest.fn();
  const createMany = jest.fn();

  const service = new AssistantService(
    {
      aiMessage: { findMany, createMany },
      aiConversation: { update: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
    } as unknown as PrismaService,
    {} as unknown as GymConfigService,
    {} as unknown as MembershipService,
    {} as unknown as PaymentsService,
    {} as unknown as MeCheckInsService,
    {} as unknown as PlansService,
    {} as unknown as GeminiGateway,
    {} as unknown as OpeningHoursService,
    {} as unknown as AssistantSettingsService,
  );

  // Private, deliberately: the invariant is worth reaching in for.
  const loadHistory = (
    service as unknown as { loadHistory: (id: string) => Promise<{ role: string }[]> }
  ).loadHistory.bind(service);
  const record = (
    service as unknown as {
      record: (id: string, q: string, a: string, n: number) => Promise<void>;
    }
  ).record.bind(service);

  beforeEach(() => {
    findMany.mockReset();
    createMany.mockReset();
    createMany.mockResolvedValue({ count: 2 });
  });

  it('orders with a role tiebreak so a tied pair reloads USER first', async () => {
    findMany.mockResolvedValue([]);

    await loadHistory('c1');

    const [args] = findMany.mock.calls[0] as [{ orderBy: unknown }];
    // The DESC window wants ASSISTANT before USER within a tie ('A' < 'U', so
    // role asc), which the reverse then flips to USER-first. Alphabetical
    // luck — documented in the service — but asserted here so a refactor that
    // drops the tiebreak fails a test instead of every second message.
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { role: 'asc' }]);
  });

  it('never hands Gemini a history that starts with a model turn', async () => {
    // The production shape: identical timestamps, ASSISTANT returned first in
    // the DESC window (so after reverse it would lead without the guard).
    findMany.mockResolvedValue([
      { role: 'USER', content: 'hi are you here?' },
      { role: 'ASSISTANT', content: 'Yes, I am here!' },
    ]);

    const history = await loadHistory('c1');

    expect(history[0]?.role).toBe('user');
  });

  it('drops a reply stranded at the head when the window cuts a pair in half', async () => {
    // take: 20 counts ROWS. A conversation 11 exchanges long loses the oldest
    // question but keeps its answer — which would lead as a model turn.
    //
    // The mock is in the DESC order the query returns: newest row first, and
    // within a pair the ANSWER is newer than its question.
    findMany.mockResolvedValue([
      { role: 'ASSISTANT', content: 'newest answer' },
      { role: 'USER', content: 'newest question' },
      { role: 'ASSISTANT', content: 'stranded answer, its question fell off' },
    ]);

    const history = await loadHistory('c1');

    expect(history[0]).toMatchObject({ role: 'user' });
    expect(history).toHaveLength(2);
  });

  it('returns an empty history for a fresh conversation', async () => {
    findMany.mockResolvedValue([]);
    await expect(loadHistory('c1')).resolves.toEqual([]);
  });

  it('records the pair with explicit timestamps one millisecond apart', async () => {
    await record('c1', 'question', 'answer', 1);

    const [{ data }] = createMany.mock.calls[0] as [{ data: { role: string; createdAt: Date }[] }];
    const user = data.find((row) => row.role === 'USER');
    const assistant = data.find((row) => row.role === 'ASSISTANT');

    expect(user?.createdAt).toBeInstanceOf(Date);
    expect(assistant!.createdAt.getTime() - user!.createdAt.getTime()).toBe(1);
  });
});
