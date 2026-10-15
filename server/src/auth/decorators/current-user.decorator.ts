import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { Request } from 'express';
import type { AuthUser } from '../auth.types';

/**
 * Injects the user AuthGuard attached to the request.
 *
 * Throws rather than returning undefined if the guard did not run — that means
 * the route is @Public(), and silently handing the handler an undefined user
 * would turn a wiring mistake into a null-reference bug further downstream.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest<Request & { user?: AuthUser }>();

    if (!request.user) {
      throw new Error('@CurrentUser() used on a route that AuthGuard did not populate');
    }

    return request.user;
  },
);
