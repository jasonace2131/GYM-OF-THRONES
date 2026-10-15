import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { DomainException } from '../common/exceptions/domain.exception';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { canStartAttempt } from './assistant-budget';
import {
  classifyError,
  describeError,
  fallbackModels,
  isModelUnavailable,
  shouldTryNextModel,
  statusOf,
} from './gemini-models';
import { ModelQuota } from './model-quota';

/**
 * Past this, "try again in a minute" would be a lie: say when it is back.
 * A per-minute cool-down is always shorter; a daily one runs to the Pacific
 * midnight reset, hours away.
 */
const SAY_WHEN_BACK_AFTER_MS = 2 * 60_000;

/** What a caller tells its own users when the gateway cannot answer. */
export interface GeminiCopy {
  notConfigured: string;
  busy: string;
  /** `at` is the reset time already formatted in the gym's own clock. */
  busyUntil: (at: string) => string;
  timeout: string;
}

/** Handed to one attempt: the client, the ask's deadline, and the meter. */
export interface AttemptContext {
  client: GoogleGenerativeAI;
  /** Epoch ms. Every call must be sent with `timeout = remainingMs(deadline)`. */
  deadline: number;
  /** Count ONE request against this model's quota — call it before every send. */
  countRequest: () => void;
}

export interface RotationResult<T> {
  model: string;
  value: T;
  /** Attempts made, the successful one included. */
  attempts: number;
  startedAt: number;
}

/**
 * The Gemini machinery the member assistant and the coach's plan suggester
 * SHARE: one API client, one model rotation, one quota ledger.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE INSTANCE ON PURPOSE (feat/coach-tools refactor).
 *
 * The free quota is metered per model per PROJECT, not per feature, so a
 * member's question and a coach's plan draw on the same ~540 requests a day.
 * Two ledgers would each believe they had the whole allowance and both walk
 * into the same 429. This service is provided once, by `GeminiModule`, and
 * every Gemini caller rotates through it.
 *
 * It owns what is the same for every caller — which model next, when to give
 * up, what to log — and nothing about the request itself: each caller's
 * `attempt` builds its own model call (tools, schema, prompt).
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class GeminiGateway {
  private readonly logger = new Logger(GeminiGateway.name);
  private readonly client: GoogleGenerativeAI | null;
  private readonly models: string[];

  /**
   * Models this API key cannot reach, learned at runtime. A 404 is a property
   * of the key, so it holds for the life of the process and is re-probed on
   * the next deploy. Rate limits are tracked separately, by `quota`, with a
   * cool-down that matches the limit that was hit.
   */
  private readonly unreachable = new Set<string>();

  /**
   * Requests spent per model this minute and today, and which models are
   * resting after a 429 — so a model near its limit is tried LAST and a spent
   * one is not tried at all until it resets. See ./model-quota.
   */
  private readonly quota = new ModelQuota();

  constructor(
    config: ConfigService<Env, true>,
    private readonly gym: GymConfigService,
  ) {
    const key = config.get('GEMINI_API_KEY', { infer: true });
    // Unset is a SUPPORTED state, not a boot failure. The gym should be able to
    // run without an AI bill, and the rest of the API has no business refusing
    // to start because a chat feature is unconfigured.
    this.client = key === undefined ? null : new GoogleGenerativeAI(key);
    this.models = fallbackModels(config.get('GEMINI_MODEL', { infer: true }));

    if (this.client === null) {
      this.logger.warn('GEMINI_API_KEY unset — the assistant and plan suggestions are disabled');
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /** Throws the caller's NOT_CONFIGURED before any other work is done. */
  assertEnabled(copy: GeminiCopy): void {
    if (this.client === null) {
      throw new DomainException(
        'ASSISTANT_NOT_CONFIGURED',
        copy.notConfigured,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  /** "gemini-3.1-flash-lite 12/500 today", for a caller's success line. */
  describeQuota(model: string): string {
    return this.quota.describe(model, new Date());
  }

  /**
   * Runs `attempt` on one model at a time until one answers, the budget runs
   * out, or every model is known to refuse.
   *
   * `label` prefixes every log line ("assistant", "workout-plan"). Log lines
   * carry models, classes, statuses and times — never the request or reply.
   *
   * ONE MODEL PER ATTEMPT, and the whole request is retried on the next model
   * rather than resumed mid-flight: a half-finished tool exchange cannot be
   * handed to a different model. Cutting an attempt off is safe because
   * callers write nothing until an attempt has returned.
   */
  async rotate<T>(
    label: string,
    copy: GeminiCopy,
    budgetMs: number,
    attempt: (model: string, context: AttemptContext) => Promise<T>,
  ): Promise<RotationResult<T>> {
    this.assertEnabled(copy);
    const client = this.client!;

    // Measured from here, so the budget covers model rotation rather than
    // resetting on every attempt — and enforced on every call, not just
    // checked between attempts (see ./assistant-budget).
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    const candidates = this.models.filter((model) => !this.unreachable.has(model));

    // Every model has 404'd at some point — almost certainly a key problem
    // rather than simultaneous outages. Re-probe rather than refuse forever,
    // so a fixed key recovers without a restart.
    if (candidates.length === 0) this.unreachable.clear();

    const pool = candidates.length === 0 ? this.models : candidates;
    // Fresh models first, near-limit ones last, resting ones not at all.
    const plan = this.quota.order(pool, new Date());
    if (plan.skipped.length > 0) {
      this.logger.log(
        `${label} skipping ${plan.skipped
          .map((rest) => `${rest.model} (${rest.reason} until ${rest.until})`)
          .join(', ')}`,
      );
    }
    if (plan.usable.length === 0) {
      // Every model is known to refuse right now. Answer at once instead of
      // spending three round trips — and quota — on refusals.
      this.logger.error(`${label} gave up before trying: every model is resting`);
      throw this.exhausted(pool, copy);
    }

    const attempts: string[] = [];
    let lastError: unknown = null;
    let outOfTime = false;

    for (const model of plan.usable) {
      if (!canStartAttempt(deadline)) {
        outOfTime = true;
        break;
      }

      const attemptStartedAt = Date.now();
      try {
        const value = await attempt(model, {
          client,
          deadline,
          countRequest: () => this.quota.record(model, new Date()),
        });
        return { model, value, attempts: attempts.length + 1, startedAt };
      } catch (caught) {
        lastError = caught;
        const kind = classifyError(caught);
        if (kind === 'rate-limit') this.quota.onRateLimited(model, caught, new Date());
        const line = `${model} ${kind} status=${statusOf(caught) ?? '-'} ${Date.now() - attemptStartedAt}ms`;
        attempts.push(line);
        this.logger.warn(`${label} attempt ${attempts.length}: ${line}`);

        // The per-call timeout IS the remaining budget: nothing is left for
        // another model.
        if (kind === 'timeout') {
          outOfTime = true;
          break;
        }

        if (shouldTryNextModel(caught)) {
          // Only "this key cannot reach it" is remembered. Rate limits clear.
          if (isModelUnavailable(caught)) this.unreachable.add(model);
          continue;
        }

        // A bad request, a revoked key, a malformed schema: every other model
        // would fail identically and bury the real message.
        this.logger.error(`${label} failed on ${model}, not rotating — ${describeError(caught)}`);
        throw caught;
      }
    }

    // THE WHY, NOT JUST THE WHAT: a spent quota, a hung socket and a code bug
    // must be tellable apart from the log alone.
    this.logger.error(
      `${label} gave up after ${attempts.length} attempt(s) in ${Date.now() - startedAt} ms — ` +
        `${attempts.length === 0 ? 'no attempt started' : attempts.join('; ')} — ` +
        `last: ${describeError(lastError)}`,
    );

    if (outOfTime) {
      throw new DomainException('ASSISTANT_TIMEOUT', copy.timeout, HttpStatus.SERVICE_UNAVAILABLE);
    }
    throw this.exhausted(pool, copy);
  }

  /**
   * The user-facing "busy". When every model is resting for longer than a
   * minute or two — a spent daily quota — say when it comes back, in the
   * gym's own clock, rather than inviting a retry that cannot succeed.
   */
  private exhausted(pool: readonly string[], copy: GeminiCopy): DomainException {
    const now = new Date();
    const back = this.quota.nextAvailableAt(pool, now);
    if (
      back !== null &&
      this.quota.order(pool, now).usable.length === 0 &&
      back.getTime() - now.getTime() > SAY_WHEN_BACK_AFTER_MS
    ) {
      const at = back
        .toLocaleTimeString('en-US', {
          timeZone: this.gym.timeZone,
          hour: 'numeric',
          minute: '2-digit',
        })
        .replace(/\s/g, ' '); // newer ICU puts a narrow no-break space before AM/PM
      return new DomainException(
        'ASSISTANT_BUSY',
        copy.busyUntil(at),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return new DomainException('ASSISTANT_BUSY', copy.busy, HttpStatus.SERVICE_UNAVAILABLE);
  }
}
