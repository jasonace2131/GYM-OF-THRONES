import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthSession } from '../auth.types';

/**
 * Injects the sign-in AuthGuard attached (`request.authSession`). Throws, like
 * @CurrentUser(), when the guard did not run, rather than handing a handler
 * an undefined session.
 */
export const CurrentAuthSession = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthSession => {
    const request = ctx.switchToHttp().getRequest<Request & { authSession?: AuthSession }>();

    if (!request.authSession) {
      throw new Error('@CurrentAuthSession() used on a route that AuthGuard did not populate');
    }

    return request.authSession;
  },
);
