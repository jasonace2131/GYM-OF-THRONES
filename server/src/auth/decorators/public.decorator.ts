import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Opts an endpoint (or a whole controller) out of authentication.
 *
 * AuthGuard runs on every route by default, so anything reachable without a
 * token — the health check, the public landing content — must say so here.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
