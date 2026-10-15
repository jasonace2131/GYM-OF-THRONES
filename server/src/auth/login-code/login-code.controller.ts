import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { LoginCodeSendResult, LoginCodeVerified } from '@got/shared';
import { AllowUnverifiedLogin } from '../decorators/allow-unverified-login.decorator';
import { CurrentAuthSession } from '../decorators/current-auth-session.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginCodeService } from './login-code.service';
import { VerifyLoginCodeDto } from './verify-login-code.dto';

/**
 * The emailed sign-in code's two calls. Authenticated (the Supabase token is
 * required) but open to a sign-in that has not entered its code yet — the
 * only two routes in the API that are.
 */
@Controller('auth/login-code')
@AllowUnverifiedLogin()
export class LoginCodeController {
  constructor(private readonly codes: LoginCodeService) {}

  /** Sends (or re-sends) a code for the caller's current sign-in. */
  @Post()
  @HttpCode(200)
  @Throttle({ default: { limit: 5, ttl: 60_000 }, origin: { limit: 30, ttl: 60_000 } })
  async send(
    @CurrentUser() user: AuthUser,
    @CurrentAuthSession() session: AuthSession,
  ): Promise<LoginCodeSendResult> {
    return this.codes.send(user, session);
  }

  @Post('verify')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 }, origin: { limit: 60, ttl: 60_000 } })
  async verify(
    @Body() dto: VerifyLoginCodeDto,
    @CurrentUser() user: AuthUser,
    @CurrentAuthSession() session: AuthSession,
  ): Promise<LoginCodeVerified> {
    return this.codes.verify(user, session, dto.code);
  }
}
