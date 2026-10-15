import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginGateService } from '../login-gate.service';

/**
 * At boot: copy LOGIN_CODE_REQUIRED into `LoginCodeSetting` (the Realtime
 * policy cannot read env) — in a production process only — and say loudly
 * when the gate is on but email is off.
 *
 * Neither is fatal. A failed write leaves live chat on the LAST recorded
 * setting, or on "required" if the row is missing (the SQL fails closed); the
 * API's own gate follows the env regardless.
 */
@Injectable()
export class LoginCodeSettingSync implements OnModuleInit {
  private readonly logger = new Logger(LoginCodeSettingSync.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gate: LoginGateService,
    private readonly email: EmailService,
  ) {}

  async onModuleInit(): Promise<void> {
    const required = this.gate.required;

    if (required && !this.email.enabled) {
      this.logger.error(
        'LOGIN_CODE_REQUIRED is on but outbound email is disabled (RESEND_API_KEY / RESEND_FROM unset): ' +
          'nobody can finish signing in. Configure Resend, or set LOGIN_CODE_REQUIRED=false and restart.',
      );
    }

    // Only a production process writes the row. A local `npm run dev:server`
    // whose .env points at the shared database would otherwise flip live chat
    // to whatever that laptop's env says. Render and Railway start with
    // NODE_ENV=production; `nest start --watch` does not.
    if (process.env['NODE_ENV'] !== 'production') {
      this.logger.log(
        `Live chat's LOGIN_CODE_REQUIRED setting was not synced: this is not a production process (NODE_ENV=${process.env['NODE_ENV'] ?? 'unset'}).`,
      );
      return;
    }

    try {
      await this.prisma.loginCodeSetting.upsert({
        where: { id: 1 },
        create: { id: 1, required },
        update: { required },
      });
    } catch (error) {
      this.logger.error(
        `Could not record LOGIN_CODE_REQUIRED=${String(required)} for live chat: ${(error as Error).message}. ` +
          'Live chat keeps the last recorded setting.',
      );
    }
  }
}
