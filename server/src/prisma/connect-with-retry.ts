/**
 * Connecting to Postgres, with the one retry that matters and none of the ones
 * that hurt.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * `onModuleInit` used to call `$connect()` once. Supabase's transaction pooler
 * intermittently refuses the Postgres handshake even though the TCP socket
 * opens — observed repeatedly against this project's own pooler, always
 * succeeding on an immediate retry. A single refusal threw out of
 * `onModuleInit`, which is unhandled, which kills the process before
 * `app.listen()` ever runs. On Railway that is a container that never binds a
 * port: the healthcheck times out, `restartPolicyMaxRetries` burns through its
 * three attempts, and the deploy is reported as failed — with a log that says
 * "can't reach database server" about a database that is, in fact, up.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY IT DOES NOT RETRY EVERYTHING
 *
 * A wrong password is not a blip. Retrying `P1000` five times turns an
 * instantly diagnosable "authentication failed" into ten seconds of silence
 * followed by the same error, and does it on every restart forever. Only
 * transport-class failures are retried; every configuration-class failure
 * still crashes immediately and loudly, which is the behaviour
 * `env.validation.ts` deliberately established for the rest of the config.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THE BUDGET IS SMALL
 *
 * Nest does not bind the HTTP port until module initialisation resolves, so
 * every millisecond spent here is a millisecond Railway's healthcheck is
 * counting, and its `healthcheckTimeout` is 30 s (`railway.json`).
 *
 * THE BACKOFF IS NOT THE COST. Five attempts at 250 ms exponential backoff
 * spend only 3.75 s sleeping, but Prisma applies its OWN connection timeout to
 * each attempt. Measured against a dead port, the full budget takes **~16 s**
 * wall-clock, not four — the backoff is roughly a quarter of it. That still
 * dies inside the 30 s window, so a genuinely unreachable database fails the
 * container fast and lets Railway restart it, which is the intended outcome.
 *
 * The path that actually matters is the happy one: a transient refusal that
 * recovers on the second attempt costs one Prisma timeout plus 250 ms — a few
 * seconds, nowhere near the window. Raising `CONNECT_MAX_ATTEMPTS` is
 * therefore much more expensive than the backoff arithmetic suggests. Measure
 * before changing it.
 * ─────────────────────────────────────────────────────────────────────────
 */

/**
 * Prisma initialisation errors worth trying again.
 *
 * P1001 can't reach the server · P1002 reached it but timed out
 * P1008 operation timed out   · P1017 server closed the connection
 *
 * Deliberately absent: P1000 (auth failed), P1003 (no such database),
 * P1010 (access denied), P1011 (TLS), P1012 (schema invalid). Each is a
 * misconfiguration that will fail identically on every attempt.
 */
export const RETRYABLE_CONNECT_CODES: ReadonlySet<string> = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
]);

export const CONNECT_MAX_ATTEMPTS = 5;
export const CONNECT_BASE_DELAY_MS = 250;

/** Prisma hangs its code on `errorCode`; read it without asserting a shape. */
export function prismaErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' ? code : undefined;
}

export function isRetryableConnectError(error: unknown): boolean {
  const code = prismaErrorCode(error);
  return code !== undefined && RETRYABLE_CONNECT_CODES.has(code);
}

export interface ConnectWithRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  /** Injected so tests do not spend real seconds proving backoff happens. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, so a real outage is visible in the logs. */
  onRetry?: (info: { attempt: number; maxAttempts: number; delayMs: number; error: unknown }) => void;
}

/**
 * Runs `connect`, retrying only transport-class failures with exponential
 * backoff. Rethrows the LAST error once the budget is spent, so an exhausted
 * retry is still a crash — the process dying on an unreachable database is
 * correct; dying on the first flicker was not.
 */
export async function connectWithRetry(
  connect: () => Promise<void>,
  options: ConnectWithRetryOptions = {},
): Promise<void> {
  const {
    maxAttempts = CONNECT_MAX_ATTEMPTS,
    baseDelayMs = CONNECT_BASE_DELAY_MS,
    sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    onRetry,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      await connect();
      return;
    } catch (error) {
      // Out of budget, or a failure that will never succeed on a retry.
      if (attempt >= maxAttempts || !isRetryableConnectError(error)) throw error;

      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      onRetry?.({ attempt, maxAttempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}
