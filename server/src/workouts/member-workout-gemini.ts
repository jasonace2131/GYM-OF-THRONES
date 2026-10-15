import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain.exception';
import type {
  AttemptContext,
  GeminiCopy,
  GeminiGateway,
  RotationResult,
} from '../assistant/gemini-gateway.service';

/**
 * The member's words when the shared Gemini gateway cannot answer
 * (feat/member-workouts). The quota is SHARED with the member assistant and
 * the coach's plan suggester — one free-tier allowance per project.
 */
export const MEMBER_COPY: GeminiCopy & { unusable: string } = {
  notConfigured: 'AI plans are switched off right now. Try again later.',
  busy: 'The AI is busy right now. Try again in a minute.',
  busyUntil: (at) => `The AI has used today's allowance. It will be back at ${at}.`,
  timeout: 'It took too long. Try again.',
  unusable: 'The AI wrote something we could not use. Try again.',
};

/**
 * A reply this code could not use: a line that was not one of the three
 * events, a day for a weekday the member did not choose, a plan that fails
 * `parseMemberPlan`.
 *
 * `status = 502` ON PURPOSE. The gateway rotates on what `gemini-models.ts`
 * classifies as an upstream fault (any status >= 500) and treats a plain
 * Error as fatal — "every other model would fail identically". A model that
 * wrote garbage is exactly the opposite: a per-model failure the next model
 * usually does not repeat. Wearing 502 is how this error says so in the
 * gateway's own language, and its log line reads `upstream status=502`.
 */
export class UnusableReplyError extends Error {
  readonly status = 502;

  constructor(readonly reason: string) {
    super(`unusable reply: ${reason}`);
    this.name = 'UnusableReplyError';
  }
}

/**
 * Thrown inside an attempt when a write matched no row: the member cancelled
 * (or replaced) the draft while the model was writing. Not a Gemini failure,
 * so the gateway does not rotate, and the job stops quietly.
 */
export class DraftGoneError extends Error {
  constructor() {
    super('draft gone');
    this.name = 'DraftGoneError';
  }
}

/**
 * `gemini.rotate` with the member's copy, plus one mapping the gateway cannot
 * do itself: when the rotation is exhausted and the LAST attempt was an
 * unusable reply, the member is told "we could not use it" rather than
 * "busy" — the AI answered; it just answered badly.
 */
export async function rotateForMember<T>(
  gemini: GeminiGateway,
  label: string,
  budgetMs: number,
  attempt: (model: string, context: AttemptContext) => Promise<T>,
): Promise<RotationResult<T>> {
  let lastWasUnusable = false;
  try {
    return await gemini.rotate(label, MEMBER_COPY, budgetMs, async (model, context) => {
      lastWasUnusable = false;
      try {
        return await attempt(model, context);
      } catch (caught) {
        lastWasUnusable = caught instanceof UnusableReplyError;
        throw caught;
      }
    });
  } catch (caught) {
    if (lastWasUnusable && caught instanceof DomainException && caught.code === 'ASSISTANT_BUSY') {
      throw new DomainException(
        'WORKOUT_PLAN_SUGGESTION_INVALID',
        MEMBER_COPY.unusable,
        HttpStatus.BAD_GATEWAY,
      );
    }
    throw caught;
  }
}
