import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { RealtimeBroadcastService } from './realtime-broadcast.service';
import type { BroadcastMessage } from './chat-broadcast';

const SECRET_BODY = 'SECRET-MESSAGE-BODY-4471';

const message: BroadcastMessage = {
  topic: 'user:auth-1',
  event: 'chat.message',
  payload: {
    threadId: 't1',
    message: {
      id: 'm1',
      threadId: 't1',
      senderId: 'u1',
      body: SECRET_BODY,
      createdAt: '2026-09-25T02:00:00.000Z',
      editedAt: null,
      deletedAt: null,
    },
    clientId: null,
  },
  private: true,
};

describe('RealtimeBroadcastService', () => {
  let fetchMock: jest.Mock;
  let logs: string[];

  const build = (serviceKey: string | undefined): RealtimeBroadcastService =>
    new RealtimeBroadcastService({
      get: (key: string) =>
        key === 'SUPABASE_URL'
          ? 'https://project.supabase.co/'
          : key === 'SUPABASE_SERVICE_KEY'
            ? serviceKey
            : undefined,
    } as unknown as ConfigService<Env, true>);

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock;
    logs = [];
    for (const level of ['log', 'warn', 'error'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logs.push(String(args[0]));
      });
    }
  });

  afterEach(() => jest.restoreAllMocks());

  it("POSTs Supabase's broadcast endpoint with the service key", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 202 });

    await expect(build('service-key').send([message])).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://project.supabase.co/realtime/v1/api/broadcast');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      apikey: 'service-key',
      Authorization: 'Bearer service-key',
      'Content-Type': 'application/json',
    });
    expect(JSON.parse(init.body as string)).toEqual({ messages: [message] });
  });

  it('without SUPABASE_SERVICE_KEY, warns ONCE and sends nothing', async () => {
    const service = build(undefined);

    await expect(service.send([message])).resolves.toBe(false);
    await expect(service.send([message])).resolves.toBe(false);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs.filter((line) => /SUPABASE_SERVICE_KEY/.test(line))).toHaveLength(1);
  });

  it('never throws: a network failure or a refusal is logged by status and count only', async () => {
    const service = build('service-key');

    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(service.send([message])).resolves.toBe(false);

    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    await expect(service.send([message])).resolves.toBe(false);

    expect(logs.join('\n')).toContain('status=401');
    expect(logs.join('\n')).not.toContain(SECRET_BODY);
    expect(logs.join('\n')).not.toContain('service-key');
  });

  it('publish() is fire-and-forget: it returns at once and swallows a rejection', async () => {
    let settle: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((resolve) => (settle = resolve)));

    expect(build('service-key').publish([message])).toBeUndefined();

    settle({ ok: true, status: 202 });
    await Promise.resolve();
  });

  it('sends nothing for an empty list', async () => {
    await expect(build('service-key').send([])).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
