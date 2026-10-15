import { GoogleGenerativeAI, GoogleGenerativeAIAbortError } from '@google/generative-ai';
import { generationConfigFor, isTimeout, shouldTryNextModel } from './gemini-models';

/**
 * THE SDK ITSELF, with only `fetch` replaced.
 *
 * `thinkingConfig` is not in @google/generative-ai 0.24.1's types, and the
 * per-call timeout is an option most callers never pass. Both are claims
 * about what reaches the wire, so they are asserted against the real
 * GoogleGenerativeAI rather than a mock of it: an SDK upgrade that stops
 * forwarding either one fails here, not silently in production.
 */
describe('@google/generative-ai on the wire', () => {
  const KEY = 'test-key-7f3a9c';
  let fetchMock: jest.SpyInstance;

  const okResponse = (): Response =>
    ({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          candidates: [
            { content: { role: 'model', parts: [{ text: 'Monday:' }] }, finishReason: 'STOP' },
          ],
        }),
    }) as unknown as Response;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchMock.mockRestore();
    // Drops the SDK's own abort timer, which it never clears after success.
    jest.useRealTimers();
  });

  const send = async (model: string, timeout?: number): Promise<[string, RequestInit]> => {
    const chat = new GoogleGenerativeAI(KEY)
      .getGenerativeModel({ model, generationConfig: generationConfigFor(model) })
      .startChat({ history: [] });
    await chat.sendMessage('make me a plan', timeout === undefined ? undefined : { timeout });
    return fetchMock.mock.calls[0] as [string, RequestInit];
  };

  it('sends thinkingBudget 0 and the output cap to a 2.5 Flash model', async () => {
    const [, init] = await send('gemini-2.5-flash', 5_000);
    const body = JSON.parse(init.body as string) as {
      generationConfig: { maxOutputTokens: number; thinkingConfig: { thinkingBudget: number } };
    };

    expect(body.generationConfig.thinkingConfig.thinkingBudget).toBe(0);
    expect(body.generationConfig.maxOutputTokens).toBe(2048);
  });

  it('sends no thinkingConfig to a model that was not given one', async () => {
    const [, init] = await send('gemini-3.1-flash-lite', 5_000);
    const body = JSON.parse(init.body as string) as { generationConfig: object };

    expect(body.generationConfig).toEqual({ maxOutputTokens: 2048 });
  });

  it('turns a per-call timeout into an abort signal on the fetch', async () => {
    const [, init] = await send('gemini-2.5-flash', 5_000);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps the key out of the URL — it travels in a header', async () => {
    const [url, init] = await send('gemini-2.5-flash', 5_000);

    expect(url).not.toContain(KEY);
    expect(url).not.toMatch(/[?&]key=/);
    expect(new Headers(init.headers).get('x-goog-api-key')).toBe(KEY);
  });

  /**
   * The end-to-end shape of a budget running out: the SDK's timer fires, the
   * fetch rejects with the platform's AbortError, and the SDK rethrows it as
   * its own class. `isTimeout` must see THAT, and it must not rotate.
   */
  it('throws its abort class when the timeout fires, and that is a timeout', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(new DOMException('This operation was aborted', 'AbortError')),
          );
        }),
    );

    const chat = new GoogleGenerativeAI(KEY)
      .getGenerativeModel({ model: 'gemini-2.5-flash' })
      .startChat({ history: [] });
    const pending = chat.sendMessage('make me a plan', { timeout: 5_000 });
    const settled = pending.catch((caught: unknown) => caught);

    await jest.advanceTimersByTimeAsync(5_000);
    const caught = await settled;

    expect(caught).toBeInstanceOf(GoogleGenerativeAIAbortError);
    expect(isTimeout(caught)).toBe(true);
    expect(shouldTryNextModel(caught)).toBe(false);
  });
});
