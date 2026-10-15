import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import type { ApiErrorResponse } from '@got/shared';
import { mapPrismaError } from '../exceptions/prisma-error.mapper';

/**
 * Catches all unhandled exceptions and returns a consistent error shape.
 *
 * The error code is resolved in this order:
 *   1. a `code` on the exception's response body — DomainException puts one
 *      there, and it is the only thing the client is meant to branch on;
 *   2. `HTTP_<status>` for any other HttpException, so ValidationPipe's 400
 *      (whose body is { statusCode, message, error } and carries no code)
 *      still reports HTTP_400 and nothing regresses;
 *   3. a mapped Prisma constraint violation → 422 with its named code;
 *   4. INTERNAL_SERVER_ERROR.
 *
 * Non-HttpExceptions are logged in full server-side and their internal details
 * are NEVER leaked to the client.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const httpException =
      exception instanceof HttpException ? exception : mapPrismaError(exception);

    // Nothing recognised it, so it is a genuine unhandled throw: log the stack.
    // A mapped Prisma error already logged its raw constraint name in the mapper.
    if (httpException === null) {
      this.logger.error(
        `Unhandled exception on ${request.method} ${request.url}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    const statusCode = httpException?.getStatus() ?? HttpStatus.INTERNAL_SERVER_ERROR;
    const body = httpException?.getResponse() ?? null;
    const record =
      typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;

    const rawMessage =
      typeof body === 'string'
        ? body
        : (record?.['message'] ?? (httpException ? 'An error occurred' : 'Internal server error'));

    const code =
      typeof record?.['code'] === 'string'
        ? record['code']
        : httpException
          ? `HTTP_${statusCode}`
          : 'INTERNAL_SERVER_ERROR';

    const message =
      typeof rawMessage === 'string'
        ? rawMessage
        : Array.isArray(rawMessage)
          ? rawMessage.join(', ')
          : 'An error occurred';

    const details = record?.['details'];

    const errorBody: ApiErrorResponse = {
      success: false,
      error: details === undefined ? { code, message } : { code, message, details },
    };

    response.status(statusCode).json(errorBody);
  }
}
