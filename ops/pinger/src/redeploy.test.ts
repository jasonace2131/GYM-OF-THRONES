import { describe, expect, it } from 'vitest';
import { REDEPLOY_COOLDOWN_MS, handleUpdate, parseCommand, type CommandEnv } from './commands';

const GROUP = '-5492583912';
const HOOK = 'https://api.render.com/deploy/srv-abc123?key=SECRETKEY';
const NOW = Date.parse('2026-09-23T03:00:00Z');
const clock = () => NOW;

function memoryKv(initial: Record<string, unknown> = {}) {
  const store = new Map(Object.entries(initial).map(([k, v]) => [k, JSON.stringify(v)]));
  const writes: string[] = [];
  return {
    get: async (key: string) => (store.has(key) ? JSON.parse(store.get(key) as string) : null),
    put: async (key: string, value: string) => {
      writes.push(key);
      store.set(key, value);
    },
    read: (key: string) => (store.has(key) ? JSON.parse(store.get(key) as string) : null),
    writes,
  };
}

// `null` means "not configured". Passing `undefined` would silently pick up
// the default and hand in the real hook - which is how this test first lied.
function env(kv = memoryKv(), hook: string | null = HOOK): CommandEnv & { PINGER_STATE: ReturnType<typeof memoryKv> } {
  return {
    HEALTH_URL: 'https://site.test/api/health',
    DIRECT_URL: 'https://api.test/api/health',
    TELEGRAM_CHAT_ID: GROUP,
    BOT_USERNAME: 'GYM_OF_THRONES_BOT',
    RENDER_DEPLOY_HOOK: hook ?? undefined,
    PINGER_STATE: kv,
  };
}

/** Records calls to the deploy hook; answers with `status` or throws. */
function render(status: number | 'unreachable' = 200) {
  const calls: { url: string; method?: string }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method });
    if (status === 'unreachable') throw new TypeError('fetch failed');
    return new Response(JSON.stringify({ deploy: { id: 'dep-1' } }), { status });
  }) as typeof fetch;
  return { impl, calls };
}

const redeploy = (from: { id: number; first_name: string } = { id: 555, first_name: 'Ysa' }, chatId = GROUP) => ({
  message: { message_id: 9, text: '/redeploy', chat: { id: Number(chatId) }, from },
});

describe('parseCommand — redeploy', () => {
  it('accepts /redeploy and the /restart people will reach for', () => {
    expect(parseCommand('/redeploy', 'GYM_OF_THRONES_BOT')).toBe('redeploy');
    expect(parseCommand('/restart@GYM_OF_THRONES_BOT', 'GYM_OF_THRONES_BOT')).toBe('redeploy');
  });
});

describe('/redeploy', () => {
  it('starts a Render deploy and says who asked', async () => {
    const r = render(200);
    const e = env();
    const reply = await handleUpdate(redeploy(), e, r.impl, clock);

    expect(r.calls).toEqual([{ url: HOOK, method: 'POST' }]);
    expect(reply?.text).toMatch(/^🔄 Redeploy started by Ysa/);
    expect(reply?.replyTo).toBe(9);
    expect(e.PINGER_STATE.read('redeploy')).toEqual({ at: new Date(NOW).toISOString(), by: 'Ysa' });
  });

  /** The owner's decision: every member of the staff group may redeploy. */
  it('works for any member of the group, not only the owner', async () => {
    const r = render(200);
    await handleUpdate(redeploy({ id: 424242, first_name: 'Front desk' }), env(), r.impl, clock);
    expect(r.calls).toHaveLength(1);
  });

  it('does nothing for a chat outside the staff group', async () => {
    const r = render(200);
    const reply = await handleUpdate(redeploy(undefined, '999'), env(), r.impl, clock);
    expect(reply).toBeNull();
    expect(r.calls).toEqual([]);
  });

  /**
   * Two people tapping /redeploy a minute apart would queue two full builds
   * - migrations, seed and all - and spend Render build minutes twice for
   * one outage. The second tap is told what is already happening instead.
   */
  it('does not start a second deploy inside the cooldown', async () => {
    const recent = new Date(NOW - 5 * 60_000).toISOString();
    const r = render(200);
    const e = env(memoryKv({ redeploy: { at: recent, by: 'Ysa' } }));
    const reply = await handleUpdate(redeploy({ id: 2, first_name: 'Paolo' }), e, r.impl, clock);

    expect(r.calls).toEqual([]);
    expect(reply?.text).toContain('5 min ago by Ysa');
    expect(reply?.text).toContain('/check');
    expect(e.PINGER_STATE.writes).toEqual([]);
  });

  it('allows a new deploy once the cooldown has passed', async () => {
    const old = new Date(NOW - REDEPLOY_COOLDOWN_MS - 60_000).toISOString();
    const r = render(200);
    await handleUpdate(redeploy(), env(memoryKv({ redeploy: { at: old, by: 'Ysa' } })), r.impl, clock);
    expect(r.calls).toHaveLength(1);
  });

  it('explains the missing setup instead of failing silently', async () => {
    const r = render(200);
    const reply = await handleUpdate(redeploy(), env(memoryKv(), null), r.impl, clock);
    expect(r.calls).toEqual([]);
    expect(reply?.text).toContain('RENDER_DEPLOY_HOOK');
  });

  /**
   * The hook URL is itself the credential: anyone who has it can redeploy.
   * It must never appear in a reply, which every member of the group reads.
   */
  it('reports a refused deploy without revealing the hook, and does not start the cooldown', async () => {
    const r = render(404);
    const e = env();
    const reply = await handleUpdate(redeploy(), e, r.impl, clock);

    expect(reply?.text).toMatch(/^❌/);
    expect(reply?.text).toContain('HTTP 404');
    expect(reply?.text).not.toContain('SECRETKEY');
    expect(reply?.text).not.toContain('srv-abc123');
    expect(e.PINGER_STATE.writes).toEqual([]);
  });

  it('reports an unreachable Render the same way', async () => {
    const reply = await handleUpdate(redeploy(), env(), render('unreachable').impl, clock);
    expect(reply?.text).toMatch(/^❌/);
    expect(reply?.text).not.toContain('SECRETKEY');
  });

  it('never touches the scheduled alerts’ state', async () => {
    const e = env();
    await handleUpdate(redeploy(), e, render(200).impl, clock);
    expect(e.PINGER_STATE.writes).toEqual(['redeploy']);
  });
});
