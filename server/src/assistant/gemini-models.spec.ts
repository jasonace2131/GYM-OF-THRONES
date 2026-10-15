import {
  GoogleGenerativeAIAbortError,
  GoogleGenerativeAIError,
  GoogleGenerativeAIFetchError,
} from '@google/generative-ai';
import {
  classifyError,
  describeError,
  fallbackModels,
  generationConfigFor,
  isModelUnavailable,
  isRateLimited,
  isTimeout,
  isTransportFault,
  isUpstreamFault,
  shouldTryNextModel,
} from './gemini-models';

describe('fallbackModels', () => {
  /**
   * PRUNED 2026-09-24. The list used to hold eight models; the 2.0 pair is
   * shut down (and 404'd for this key before that), the 1.5 line is retired,
   * and 2.5-pro has no free quota and cannot switch its thinking off. Every
   * dead entry cost a failed round-trip before an answer could even start.
   */
  it('is the three models that can still answer, most generous free tier first', () => {
    expect(fallbackModels()).toEqual([
      'gemini-3.1-flash-lite',
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
    ]);
  });

  it('carries no retired, shut-down or no-free-quota model', () => {
    const models = fallbackModels();
    for (const dead of [
      'gemini-2.0-flash',
      'gemini-2.0-flash-lite',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-2.5-pro',
    ]) {
      expect(models).not.toContain(dead);
    }
  });

  /**
   * GEMINI_MODEL tunes the FIRST choice without giving up the fallbacks —
   * replacing the list would defeat the entire point of having one.
   */
  it('puts a configured model first and keeps every fallback behind it', () => {
    const models = fallbackModels('gemini-3.5-flash-lite');
    expect(models[0]).toBe('gemini-3.5-flash-lite');
    expect(models.slice(1)).toEqual(fallbackModels());
  });

  it('does not list a configured model twice', () => {
    const models = fallbackModels('gemini-2.5-flash');
    expect(models[0]).toBe('gemini-2.5-flash');
    expect(models.filter((m) => m === 'gemini-2.5-flash')).toHaveLength(1);
    expect(new Set(models).size).toBe(models.length);
  });
});

describe('isRateLimited', () => {
  it.each<[unknown, string]>([
    [{ status: 429 }, 'HTTP 429'],
    [{ message: 'Quota exceeded for quota metric' }, 'quota wording'],
    [{ message: 'Rate limit reached' }, 'rate limit wording'],
    [{ message: 'Too Many Requests' }, 'too many requests'],
    [{ message: 'RESOURCE_EXHAUSTED' }, 'the gRPC status name'],
  ])('treats %j as exhausted (%s)', (error) => {
    expect(isRateLimited(error)).toBe(true);
    expect(shouldTryNextModel(error)).toBe(true);
  });

  it("recognises the SDK's own 429", () => {
    const error = new GoogleGenerativeAIFetchError(
      'Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: [429 Too Many Requests] You exceeded your current quota',
      429,
      'Too Many Requests',
    );
    expect(isRateLimited(error)).toBe(true);
    expect(shouldTryNextModel(error)).toBe(true);
  });

  it.each<[unknown]>([[null], [undefined], ['a string'], [42], [{ status: 400 }]])(
    'does not for %j',
    (error) => {
      expect(isRateLimited(error)).toBe(false);
    },
  );
});

describe('isModelUnavailable', () => {
  /**
   * THE FIX ON THE ORIGINAL, and the reason it matters.
   *
   * The version this was ported from treated anything that was not a rate
   * limit as fatal — so one retired or misspelled model at the head of the
   * list took the whole assistant down with good fallbacks underneath it
   * unused. Model names come and go on the free tier faster than anyone
   * updates a constant.
   */
  it.each<[unknown, string]>([
    [{ status: 404 }, 'HTTP 404'],
    [{ message: 'models/gemini-9.9-flash is not found for API version v1beta' }, 'not found'],
    [{ message: 'Model is not supported for generateContent' }, 'unsupported method'],
    [{ message: 'The model does not exist' }, 'does not exist'],
  ])('moves on from %j (%s)', (error) => {
    expect(isModelUnavailable(error)).toBe(true);
    expect(shouldTryNextModel(error)).toBe(true);
  });
});

describe('isTimeout', () => {
  /**
   * What the SDK throws when the per-call `timeout` fires: it wraps the
   * platform's AbortError in its own class, with "Request aborted" in the
   * message. Before this helper, that matched none of the rotation patterns
   * and reached the member as a bare 500.
   */
  it('recognises the SDK abort class', () => {
    const error = new GoogleGenerativeAIAbortError(
      'Request aborted when fetching https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: This operation was aborted',
    );
    expect(isTimeout(error)).toBe(true);
  });

  it.each<[unknown, string]>([
    [
      new DOMException('This operation was aborted', 'AbortError'),
      'an abort while the body was read',
    ],
    [new DOMException('The operation timed out.', 'TimeoutError'), 'AbortSignal.timeout'],
    [{ message: 'Request aborted when fetching …' }, 'the wording alone'],
  ])('recognises %s', (error) => {
    expect(isTimeout(error)).toBe(true);
  });

  it('does not rotate on a timeout — the budget is already spent', () => {
    expect(shouldTryNextModel(new GoogleGenerativeAIAbortError('Request aborted'))).toBe(false);
    expect(shouldTryNextModel(new DOMException('aborted', 'AbortError'))).toBe(false);
  });

  it.each<[unknown]>([[null], ['aborted'], [{ status: 429 }], [new Error('fetch failed')]])(
    'is not fooled by %j',
    (error) => {
      expect(isTimeout(error)).toBe(false);
    },
  );
});

describe('isTransportFault', () => {
  /**
   * The connection itself failed — DNS, a reset socket, a dropped TLS
   * handshake. The SDK wraps it as a plain GoogleGenerativeAIError with no
   * status. It says nothing about the model, so the next one is worth a try;
   * before this it fell through as fatal and the member saw a 500.
   */
  it.each<[unknown, string]>([
    [
      new GoogleGenerativeAIError(
        'Error fetching from https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent: fetch failed',
      ),
      'fetch failed',
    ],
    [{ message: 'read ECONNRESET' }, 'ECONNRESET'],
    [{ message: 'connect ETIMEDOUT 142.250.0.1:443' }, 'ETIMEDOUT'],
    [{ message: 'socket hang up' }, 'socket hang up'],
  ])('rotates on %s', (error) => {
    expect(isTransportFault(error)).toBe(true);
    expect(shouldTryNextModel(error)).toBe(true);
  });

  it('is not a transport fault when the server answered with a status', () => {
    // A status means the request arrived; the status decides what it was.
    expect(isTransportFault({ status: 400, message: 'fetch failed' })).toBe(false);
  });
});

describe('shouldTryNextModel', () => {
  /**
   * A bad request, a revoked key or a malformed tool schema is a bug in this
   * code or a broken deployment. Trying more models produces identical
   * failures, slower, and buries the one error message that says what is
   * actually wrong.
   */
  it.each<[unknown, string]>([
    [{ status: 400, message: 'Invalid JSON payload' }, 'bad request'],
    [{ status: 401, message: 'API key not valid' }, 'revoked key'],
    [{ status: 403, message: 'Permission denied' }, 'forbidden'],
    [new GoogleGenerativeAIFetchError('[400 Bad Request] Invalid JSON payload', 400), 'SDK 400'],
  ])('fails fast on %j (%s)', (error) => {
    expect(shouldTryNextModel(error)).toBe(false);
  });

  /**
   * FLIPPED, AGAINST A PRODUCTION SCREENSHOT. The first version of this file
   * asserted a 500 fails fast, reasoning a server fault fails identically on
   * every model. Live traffic showed Gemini's free tier throwing transient
   * per-model 503 "overloaded" and bare 500s — and the next model answering
   * fine. Each fail-fast turned that blip into a raw "Internal server error"
   * in a member's chat.
   */
  it.each<[unknown, string]>([
    [{ status: 500, message: 'Internal error' }, 'bare 500'],
    [{ status: 503, message: 'Service Unavailable' }, '503'],
    [{ message: 'The model is overloaded. Please try again later.' }, 'overloaded'],
  ])('rotates on the upstream fault %j (%s)', (error) => {
    expect(isUpstreamFault(error)).toBe(true);
    expect(shouldTryNextModel(error)).toBe(true);
  });

  it('does not confuse an upstream fault with an unreachable model', () => {
    // Only 404s are cached for the life of the process; a 503 clears on its
    // own and remembering it would retire a healthy model over one blip.
    expect(isModelUnavailable({ status: 503, message: 'overloaded' })).toBe(false);
  });
});

describe('classifyError', () => {
  it.each<[unknown, string]>([
    [new GoogleGenerativeAIAbortError('Request aborted'), 'timeout'],
    [{ status: 429 }, 'rate-limit'],
    [{ status: 404 }, 'unavailable'],
    [{ status: 503 }, 'upstream'],
    [{ message: 'fetch failed' }, 'transport'],
    [{ status: 400, message: 'Invalid JSON payload' }, 'fatal'],
    [null, 'fatal'],
  ])('%j is %s', (error, expected) => {
    expect(classifyError(error)).toBe(expected);
  });
});

describe('describeError', () => {
  it('names the class, the status and the message', () => {
    const error = new GoogleGenerativeAIFetchError('[429 Too Many Requests] quota', 429);
    expect(describeError(error)).toBe(
      'GoogleGenerativeAIFetchError status=429: [GoogleGenerativeAI Error]: [429 Too Many Requests] quota',
    );
  });

  it('shows the DOMException name, which the class alone does not say', () => {
    expect(describeError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(
      'DOMException(TimeoutError) status=-: The operation timed out.',
    );
  });

  it('cuts the message to 300 characters', () => {
    const line = describeError(new Error('x'.repeat(1_000)));
    const message = line.slice(line.indexOf(': ') + 2);
    expect(message.length).toBeLessThanOrEqual(300);
  });

  /**
   * The key travels in a header, never the URL, so it should not be in an
   * error at all. But a log line is forever, and this costs one regex.
   */
  it('redacts anything shaped like a Google API key', () => {
    const key = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
    expect(key).toHaveLength(39);
    const line = describeError(new Error(`bad key ${key} rejected ${key}`));
    expect(line).not.toContain('AIza');
    expect(line).toContain('[redacted-key]');
  });

  it('redacts before cutting, so a key straddling the cut cannot leak its head', () => {
    const key = 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q';
    const line = describeError(new Error('x'.repeat(280) + key));
    expect(line).not.toContain('AIza');
  });

  it('describes something that is not an Error', () => {
    expect(describeError('boom')).toBe('string: boom');
    expect(describeError(null)).toBe('none');
  });
});

describe('generationConfigFor', () => {
  /**
   * 2.5 Flash thinks by default, and on the free tier those thinking tokens
   * are both SLOW (seconds before the first answer token) and billed against
   * the output cap. A workout plan does not need them.
   */
  it.each(['gemini-2.5-flash', 'gemini-2.5-flash-lite'])(
    'switches thinking off for %s and caps the output',
    (model) => {
      expect(generationConfigFor(model)).toEqual({
        maxOutputTokens: 2048,
        thinkingConfig: { thinkingBudget: 0 },
      });
    },
  );

  /**
   * Sent ONLY where it is known to be accepted. An unsupported field is a
   * 400, a 400 fails fast by design, and so one wrong field would take the
   * whole rotation down rather than one model.
   */
  it.each(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-2.5-pro'])(
    'sends no thinking config to %s',
    (model) => {
      expect(generationConfigFor(model)).toEqual({ maxOutputTokens: 2048 });
    },
  );

  it('leaves temperature to the model', () => {
    expect(generationConfigFor('gemini-2.5-flash')).not.toHaveProperty('temperature');
  });
});
