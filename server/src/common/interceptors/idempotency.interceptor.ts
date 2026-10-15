import {
  BadRequestException,
  HttpStatus,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { catchError, concatMap, defer, from, of, throwError, type Observable } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { IDEMPOTENCY_HEADER, IDEMPOTENT_KEY } from '../decorators/idempotent.decorator';
import { DomainException } from '../exceptions/domain.exception';
import { hashRequestBody } from '../idempotency/request-hash';
import type { AuthUser } from '../../auth/auth.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Replay protection for money and attendance writes.
 *
 * The claim is `createMany({ skipDuplicates: true })` — INSERT ... ON CONFLICT
 * DO NOTHING — and never a caught unique violation, because inside
 * `prisma.$transaction` Postgres aborts on the first statement error and every
 * later statement dies with 25P02 (§4.6d). Nothing here opens a transaction at
 * all, and the non-throwing form is used anyway so the pattern is the one
 * chunks 1-2 copy.
 *
 * POSITION MATTERS. Registered as an APP_INTERCEPTOR this is the OUTERMOST
 * interceptor — Nest applies module-provided enhancers inside
 * NestFactory.create, and main.ts appends TransformInterceptor afterwards. So
 * the value observed here is the finished response body, the replay emits that
 * value verbatim, and nothing re-wraps it: exactly one envelope on the first
 * response and on every replay. idempotency.e2e-spec.ts asserts the exact
 * shape, so a reordering that would double-wrap fails loudly.
 *
 * `next.handle()` is called inside `defer(...)` rather than directly. In the
 * real Nest pipeline this is provably a no-op — the CallHandler Nest hands a
 * custom interceptor is already defer-wrapped internally
 * (@nestjs/core/interceptors/interceptors-consumer.js), so `next.handle()`
 * can never throw synchronously there. It is required by the hand-built
 * CallHandler in idempotency.interceptor.spec.ts's "releases the claim when
 * the handler throws" test, which throws synchronously to exercise the
 * release path without a full Nest bootstrap. Keeping it costs nothing in
 * production and keeps that unit test meaningful.
 *
 * The release-on-failure branch below only wraps `next.handle()`, not the
 * `idempotencyRecord.update(...)` that follows a successful handler run.
 * That split is deliberate and safety-critical: if the handler has already
 * committed (charged a card, created a row) and only the *bookkeeping*
 * write fails afterwards, deleting the claim would let a retry run the
 * handler again and double-charge. A stuck claim that needs support to
 * clear it by hand is a strictly safer failure mode than a silent duplicate
 * charge, so a post-success persistence failure is logged loudly and the
 * claim is left in place rather than released. Do not "simplify" this back
 * into one catchError around the whole pipe.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const isIdempotent = this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isIdempotent) return next.handle();

    const request = context.switchToHttp().getRequest<Request & { user?: AuthUser }>();
    const response = context.switchToHttp().getResponse<Response>();

    const key = request.headers[IDEMPOTENCY_HEADER];
    if (typeof key !== 'string' || !UUID_PATTERN.test(key)) {
      throw new BadRequestException('Idempotency-Key header must be a UUID');
    }
    if (!request.user) {
      throw new Error('@Idempotent() used on a route that AuthGuard did not populate');
    }

    // The CONCRETE path, not the route pattern (`request.route.path`, e.g.
    // `/memberships/:id/renew`). A pattern-keyed identity excludes the
    // resolved `:id` — one Idempotency-Key replayed against a different id
    // with an identical (small/empty) body would match on endpoint and hash,
    // and the interceptor would return the FIRST operation's stored receipt
    // with `success: true`, so e.g. member B's renewal reports success and
    // never happens. `originalUrl` includes the query string, which the hash
    // does not cover, so it is stripped.
    const endpoint = `${request.method} ${request.originalUrl.split('?')[0]}`;
    const requestHash = hashRequestBody(request.body);

    const { count } = await this.prisma.idempotencyRecord.createMany({
      data: [
        {
          key,
          userId: request.user.id,
          endpoint,
          requestHash,
          // 0 means "claimed, not yet answered". Released if the handler throws.
          responseStatus: 0,
          responseBody: {},
        },
      ],
      skipDuplicates: true,
    });

    if (count === 0) {
      const stored = await this.prisma.idempotencyRecord.findUniqueOrThrow({ where: { key } });

      if (
        stored.endpoint !== endpoint ||
        stored.requestHash !== requestHash ||
        stored.userId !== request.user.id
      ) {
        // Returning the first request's (or first CALLER's) receipt for a
        // different request is worse than no idempotency: it manufactures a
        // plausible-looking success. `key` is the global primary key, so
        // without the userId check a different authenticated caller
        // presenting the same key, endpoint and body would receive the FIRST
        // caller's stored response body verbatim — for a payment, a receipt
        // naming someone else's member and amount. A different owner is a
        // key collision, not a permission failure, hence 409 and not 403.
        throw new DomainException(
          'IDEMPOTENCY_KEY_REUSED',
          'This Idempotency-Key was already used for a different request',
          HttpStatus.CONFLICT,
        );
      }

      if (stored.responseStatus === 0) {
        // Not a business denial — the general "a denial is a 200" rule does
        // not apply here. This is a protocol-level conflict (two callers, or
        // one impatient retry, racing the same key while the first is still
        // being handled), not an outcome of the domain operation itself, so
        // it stays a thrown 409 like every other IDEMPOTENCY_KEY_REUSED case.
        throw new DomainException(
          'IDEMPOTENCY_KEY_REUSED',
          'A request with this Idempotency-Key is still in flight',
          HttpStatus.CONFLICT,
        );
      }

      this.logger.log(`Replayed ${endpoint} for key ${key}`);
      // A 201 replays as a 200: nothing was created this time.
      response.status(HttpStatus.OK);
      return of(stored.responseBody);
    }

    const declared = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    const status = declared ?? (request.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return defer(() => next.handle()).pipe(
      // Only next.handle() itself is covered by this catchError. Nothing was
      // committed if the handler failed, so releasing the claim here is safe
      // and lets the staff member retry with the same key.
      catchError((error: unknown) =>
        from(this.prisma.idempotencyRecord.deleteMany({ where: { key, responseStatus: 0 } })).pipe(
          concatMap(() => throwError(() => error)),
        ),
      ),
      // Deliberately its own concatMap, downstream of the catchError above:
      // the handler has already succeeded by the time this runs, so a
      // failure here must NOT delete the claim — see the class doc comment.
      concatMap(async (body: unknown) => {
        try {
          await this.prisma.idempotencyRecord.update({
            where: { key },
            data: {
              responseStatus: status,
              responseBody: body === undefined ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
            },
          });
        } catch (error) {
          // The handler already ran and committed — a member may already be
          // charged. Deleting the claim would let a retry run the handler
          // again and double-charge, which is strictly worse than a stuck
          // claim a human has to clear. Log loudly and leave it claimed.
          this.logger.error(
            `Idempotency record write failed AFTER handler success for key ${key} on ` +
              `${endpoint} — claim left in place, not released, to avoid a duplicate charge`,
            error instanceof Error ? error.stack : String(error),
          );
          throw error;
        }
        return body;
      }),
    );
  }
}
