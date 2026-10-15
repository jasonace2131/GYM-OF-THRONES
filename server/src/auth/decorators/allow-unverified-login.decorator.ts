import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_LOGIN_KEY = 'allowUnverifiedLogin';

/**
 * Lets a signed-in caller through BEFORE they have entered their emailed
 * sign-in code. Only the two /auth/login-code routes carry it: every other
 * authenticated route answers 401 LOGIN_CODE_REQUIRED to an unverified
 * sign-in. Not the same as @Public() — the token is still required and checked.
 */
export const AllowUnverifiedLogin = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_UNVERIFIED_LOGIN_KEY, true);
