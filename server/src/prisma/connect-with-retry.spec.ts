import {
  CONNECT_BASE_DELAY_MS,
  CONNECT_MAX_ATTEMPTS,
  connectWithRetry,
  isRetryableConnectError,
} from './connect-with-retry';

/** Shaped like a PrismaClientInitializationError without importing one. */
function prismaError(errorCode: string): Error & { errorCode: string } {
  return Object.assign(new Error(`prisma failed with ${errorCode}`), { errorCode });
}

/** Records the backoff instead of sleeping it. */
function recorder() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

describe('isRetryableConnectError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017'])('retries transport failure %s', (code) => {
    expect(isRetryableConnectError(prismaError(code))).toBe(true);
  });

  // The whole point of the allowlist. A wrong password retried five times is
  // ten seconds of silence followed by the same error, on every restart.
  it.each(['P1000', 'P1003', 'P1010', 'P1011', 'P1012'])(
    'does NOT retry configuration failure %s',
    (code) => {
      expect(isRetryableConnectError(prismaError(code))).toBe(false);
    },
  );

  it('does not retry an error with no Prisma code at all', () => {
    expect(isRetryableConnectError(new Error('socket hang up'))).toBe(false);
    expect(isRetryableConnectError(undefined)).toBe(false);
    expect(isRetryableConnectError(null)).toBe(false);
  });
});

describe('connectWithRetry', () => {
  it('does not retry when the first attempt succeeds', async () => {
    const { slept, sleep } = recorder();
    const connect = jest.fn().mockResolvedValue(undefined);

    await connectWithRetry(connect, { sleep });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('recovers from the observed failure mode — two refusals, then success', async () => {
    const { slept, sleep } = recorder();
    const connect = jest
      .fn()
      .mockRejectedValueOnce(prismaError('P1001'))
      .mockRejectedValueOnce(prismaError('P1001'))
      .mockResolvedValue(undefined);

    await connectWithRetry(connect, { sleep });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([CONNECT_BASE_DELAY_MS, CONNECT_BASE_DELAY_MS * 2]);
  });

  it('backs off exponentially and rethrows the last error once spent', async () => {
    const { slept, sleep } = recorder();
    const connect = jest.fn().mockRejectedValue(prismaError('P1001'));

    await expect(connectWithRetry(connect, { sleep })).rejects.toMatchObject({
      errorCode: 'P1001',
    });

    // Exhausting the budget must still crash: a process that stays up with no
    // database is worse than one that dies and gets restarted.
    expect(connect).toHaveBeenCalledTimes(CONNECT_MAX_ATTEMPTS);
    expect(slept).toEqual([250, 500, 1000, 2000]);
  });

  it('keeps the SLEEP budget small — the real cost is Prisma’s own timeouts', async () => {
    const { slept, sleep } = recorder();
    await connectWithRetry(jest.fn().mockRejectedValue(prismaError('P1001')), { sleep }).catch(
      () => undefined,
    );

    // 3.75s of backoff. Measured end to end against a dead port the whole
    // budget takes ~16s, because Prisma applies its own connection timeout to
    // each attempt — so raising maxAttempts costs far more than this number
    // suggests, and Nest binds no port until it resolves.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(3_750);
  });

  it('fails immediately on an auth error without sleeping', async () => {
    const { slept, sleep } = recorder();
    const connect = jest.fn().mockRejectedValue(prismaError('P1000'));

    await expect(connectWithRetry(connect, { sleep })).rejects.toMatchObject({
      errorCode: 'P1000',
    });

    expect(connect).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('reports every retry so a real outage is visible in the logs', async () => {
    const { sleep } = recorder();
    const onRetry = jest.fn();
    const connect = jest
      .fn()
      .mockRejectedValueOnce(prismaError('P1001'))
      .mockResolvedValue(undefined);

    await connectWithRetry(connect, { sleep, onRetry });

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 1, maxAttempts: CONNECT_MAX_ATTEMPTS, delayMs: 250 }),
    );
  });

  it('honours a caller-supplied budget', async () => {
    const { slept, sleep } = recorder();
    const connect = jest.fn().mockRejectedValue(prismaError('P1001'));

    await expect(
      connectWithRetry(connect, { sleep, maxAttempts: 2, baseDelayMs: 10 }),
    ).rejects.toBeDefined();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([10]);
  });
});
