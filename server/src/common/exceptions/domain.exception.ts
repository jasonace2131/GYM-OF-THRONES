import { HttpException, HttpStatus } from '@nestjs/common';
import type { DomainErrorCode } from '@got/shared';

/**
 * An expected, named failure the client is meant to branch on.
 *
 * HttpExceptionFilter reads `code` off the response body; anything thrown as a
 * plain Nest exception keeps the generic HTTP_<status> code, so adopting this
 * is opt-in and changes nothing that already exists.
 *
 * The code is typed against the closed DomainErrorCode union in @got/shared, so
 * a throw site cannot invent a code the client's switch does not handle.
 *
 * A DENIAL IS NOT ONE OF THESE. Business outcomes — expired, frozen, already
 * inside — travel as 200 payload fields, because apiFetch throws on
 * !body.success and a thrown denial reaches a member's phone as a bare Error
 * with no reason and no next step (spec 3.3 rule 2).
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    status: HttpStatus = HttpStatus.UNPROCESSABLE_ENTITY,
    /**
     * Structured extras a specific error needs beyond `code`/`message` — e.g.
     * `410 GYM_CLOSED`'s `nextOpensAt` (§7's route-42 error column). Optional
     * and rarely used: most domain errors are fully described by their code.
     * Surfaced by `HttpExceptionFilter` under `ApiErrorResponse.error.details`.
     */
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}
