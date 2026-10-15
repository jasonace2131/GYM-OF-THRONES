import { GoogleGenerativeAIAbortError, type GenerationConfig } from '@google/generative-ai';

/**
 * Which Gemini model to try, and when to give up on it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ORDERED BY FREE-TIER GENEROSITY, NOT BY CAPABILITY.
 *
 * The free tier meters each model separately, so a list is worth far more than
 * a single good model: when one is exhausted the next one's quota is still
 * untouched. Ordering by daily allowance rather than by intelligence is what
 * keeps the assistant answering all day instead of dying at lunchtime.
 *
 * The limits come from the SHSCHATBOT project's own measurements against its
 * Gemini dashboard, not from documentation:
 *
 *   Model                   RPM    RPD
 *   ─────────────────────────────────────
 *   gemini-3.1-flash-lite    15     500    best daily of the newer line
 *   gemini-2.5-flash-lite    10      20    low daily limit; thinking switched off
 *   gemini-2.5-flash          5      20    last resort; thinking switched off
 *
 * The same numbers drive FREE_TIER_LIMITS in ./model-quota, which switches
 * model BEFORE one runs out. Change both together.
 *
 * PRUNED 2026-09-24 from eight entries. Every dead entry cost one failed
 * round-trip before an answer could start, and the list had five:
 *
 *   gemini-2.0-flash, gemini-2.0-flash-lite   shut down by Google, and 404'd
 *                                             for this key before that
 *   gemini-1.5-flash, gemini-1.5-pro          retired
 *   gemini-2.5-pro                            no free quota, and its thinking
 *                                             cannot be switched off — slow
 *                                             even when it does answer
 *
 * `gemini-3.1-flash-lite` is the exact stable id on Google's model page
 * (checked 2026-09-24). Which of the three THIS key can reach was not
 * measured: on 2026-09-24 every production ask returned a fast 503 with no
 * model answering, so no `model` came back to confirm one. If a newer model
 * proves better, `GEMINI_MODEL` pins it to the front without a code change.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const DEFAULT_MODELS = [
  'gemini-3.1-flash-lite',
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
] as const;

/**
 * `GEMINI_MODEL` pins a preferred model to the FRONT of the list rather than
 * replacing it — so setting it tunes the first choice without giving up the
 * fallbacks, which is the whole point of the list.
 */
export function fallbackModels(preferred?: string): string[] {
  const list = preferred === undefined ? [...DEFAULT_MODELS] : [preferred, ...DEFAULT_MODELS];
  return [...new Set(list)];
}

/** A string property of an error, or '' — never "[object Object]". */
function textOf(error: object, key: 'message' | 'name'): string {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : '';
}

/** Quota exhausted on this model. Try the next one. */
export function isRateLimited(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const message = textOf(error, 'message');
  const status = Number((error as { status?: unknown }).status ?? 0);

  return (
    status === 429 ||
    /quota/i.test(message) ||
    /rate.?limit/i.test(message) ||
    /too many requests/i.test(message) ||
    /resource.?exhausted/i.test(message)
  );
}

/**
 * This model does not exist, or this key cannot reach it. Also try the next one.
 *
 * ONE FIX ON THE ORIGINAL, and it matters more than it looks. The version this
 * is ported from treated anything that was not a rate limit as fatal and threw
 * immediately — so a single retired or misspelled model name at the head of the
 * list took the whole assistant down, with perfectly good fallbacks sitting
 * underneath it unused.
 *
 * Model names come and go on the free tier faster than anyone updates a
 * constant. "That model is gone" is a reason to move on, not to fail.
 */
export function isModelUnavailable(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const message = textOf(error, 'message');
  const status = Number((error as { status?: unknown }).status ?? 0);

  return (
    status === 404 ||
    /not found/i.test(message) ||
    /is not supported/i.test(message) ||
    /does not exist/i.test(message) ||
    /unsupported/i.test(message)
  );
}

/**
 * Gemini's OWN outage: a 500/503 or "model is overloaded" from upstream.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * AMENDED AFTER A PRODUCTION SCREENSHOT, and the original reasoning is kept
 * because it was half right.
 *
 * The first version failed fast on every 5xx, arguing a server fault would
 * fail identically on all eight models. Live traffic proved otherwise: the
 * free tier throws transient 503 "model overloaded" and bare 500s routinely,
 * they are PER-MODEL (different serving stacks), and the next model in the
 * list answers fine. Failing fast turned each of those blips into a raw
 * "Internal server error" bubble in a member's chat.
 *
 * What stays fail-fast is what is genuinely ours: 400 (malformed request —
 * a tool-schema bug), 401/403 (a revoked or misconfigured key). Those DO
 * fail identically on every model, and burying them was the original point.
 * ═════════════════════════════════════════════════════════════════════════
 */
export function isUpstreamFault(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;

  const message = textOf(error, 'message');
  const status = Number((error as { status?: unknown }).status ?? 0);

  return (
    status >= 500 ||
    /overloaded/i.test(message) ||
    /service unavailable/i.test(message) ||
    /internal error/i.test(message) ||
    /try again later/i.test(message)
  );
}

/**
 * The call was aborted because the ask's time budget ran out.
 *
 * Three shapes, one meaning:
 *   - `GoogleGenerativeAIAbortError` — the SDK's own wrapper when its
 *     `timeout` fires during the fetch ("Request aborted when fetching …");
 *   - a bare `AbortError` — the same abort landing while the response body is
 *     being read, which the SDK does not wrap;
 *   - `TimeoutError` — `AbortSignal.timeout`, and `BudgetExhaustedError`
 *     from ./assistant-budget, thrown between tool rounds.
 */
export function isTimeout(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (error instanceof GoogleGenerativeAIAbortError) return true;

  const name = textOf(error, 'name');
  const message = textOf(error, 'message');

  return name === 'AbortError' || name === 'TimeoutError' || /request aborted/i.test(message);
}

/**
 * The connection failed before any HTTP status came back — DNS, a reset
 * socket, a dropped handshake. The SDK wraps these as a plain
 * GoogleGenerativeAIError with no status, which matched none of the patterns
 * above and so reached the member as a 500. Nothing about it is specific to
 * the model, so the next one is worth a try.
 */
export function isTransportFault(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  if (statusOf(error) !== null) return false;

  const message = textOf(error, 'message');
  return /fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i.test(message);
}

/**
 * What remains — a bad request, a revoked key, a malformed tool schema — is a
 * bug in this code or a broken deployment. Trying more models would produce
 * identical failures, slower, and bury the one error message that says what
 * is actually wrong.
 *
 * A TIMEOUT DOES NOT ROTATE either, for a different reason: the per-call
 * timeout IS the remaining budget, so when it fires there is no time left to
 * spend on another model.
 */
export function shouldTryNextModel(error: unknown): boolean {
  if (isTimeout(error)) return false;
  return (
    isRateLimited(error) ||
    isModelUnavailable(error) ||
    isUpstreamFault(error) ||
    isTransportFault(error)
  );
}

export type GeminiErrorClass =
  'timeout' | 'rate-limit' | 'unavailable' | 'upstream' | 'transport' | 'fatal';

/** One word per failure, for the per-attempt log line. */
export function classifyError(error: unknown): GeminiErrorClass {
  if (isTimeout(error)) return 'timeout';
  if (isRateLimited(error)) return 'rate-limit';
  if (isModelUnavailable(error)) return 'unavailable';
  if (isUpstreamFault(error)) return 'upstream';
  if (isTransportFault(error)) return 'transport';
  return 'fatal';
}

/** The HTTP status Gemini answered with, or null when none came back. */
export function statusOf(error: unknown): number | null {
  if (error === null || typeof error !== 'object') return null;
  const status = Number((error as { status?: unknown }).status ?? 0);
  return Number.isFinite(status) && status > 0 ? status : null;
}

const GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{35}/g;
const MAX_DESCRIBED = 300;

/**
 * An error, flattened into one line that is safe to log.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE GIVE-UP PATH USED TO LOG NOTHING ABOUT WHY.
 *
 * "every Gemini model was exhausted, unavailable, or out of time" was the
 * whole message — a 429, a 404 and a hung socket all read the same in the
 * Render log, so a quota problem could not be told from a code problem.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Anything shaped like a Google API key is redacted BEFORE the cut, so a key
 * straddling the 300th character cannot leak its first half. The key travels
 * in a header, not the URL, so none should be here — this is belt and braces
 * for a line that lives in a log forever.
 */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'none';

  if (typeof error !== 'object') {
    const text =
      typeof error === 'string' ||
      typeof error === 'number' ||
      typeof error === 'boolean' ||
      typeof error === 'bigint'
        ? String(error)
        : '';
    return `${typeof error}: ${redactAndCut(text)}`;
  }

  const ctor = (error as { constructor?: { name?: unknown } }).constructor?.name;
  const cls = typeof ctor === 'string' && ctor !== '' ? ctor : 'object';
  const name = textOf(error, 'name');
  const label = name !== '' && name !== 'Error' && name !== cls ? `${cls}(${name})` : cls;
  const status = statusOf(error);
  const message = textOf(error, 'message');

  return `${label} status=${status ?? '-'}: ${redactAndCut(message)}`;
}

function redactAndCut(text: string): string {
  return text.replace(GOOGLE_API_KEY, '[redacted-key]').slice(0, MAX_DESCRIBED);
}

/**
 * `thinkingConfig` is accepted by the API but missing from the 0.24.1 SDK's
 * types; the SDK sends `generationConfig` through untouched.
 */
export type GeminiGenerationConfig = GenerationConfig & {
  thinkingConfig?: { thinkingBudget: number };
};

/**
 * Per-model generation settings.
 *
 * `maxOutputTokens: 2048` bounds the slowest possible answer. A full weekly
 * plan in the prompt's 350-word shape is well under a thousand tokens, so the
 * cap only bites on a runaway — and `ask()` says so when it does.
 *
 * `thinkingBudget: 0` ONLY for the 2.5 Flash line. They think by default,
 * which on the free tier means seconds of silence before the first answer
 * token, and nothing here needs it. It is NOT sent anywhere else: a field a
 * model does not accept is a 400, a 400 fails fast by design, and one wrong
 * field would take the whole rotation down rather than one model.
 *
 * No temperature: the model's default is fine, and every extra field is one
 * more thing a model can reject.
 */
export function generationConfigFor(model: string): GeminiGenerationConfig {
  return /^gemini-2\.5-flash/.test(model)
    ? { maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } }
    : { maxOutputTokens: 2048 };
}
