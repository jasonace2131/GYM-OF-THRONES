import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { connectWithRetry, prismaErrorCode } from './connect-with-retry';

/**
 * Owns the Prisma connection lifecycle.
 *
 * Extending PrismaClient means every model is available directly on the
 * injected service — `this.prisma.user.findMany(...)`.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      datasources: {
        db: {
          url: process.env['DATABASE_URL'],
        },
      },
    });
  }

  /**
   * A transport blip at boot must not kill the container.
   *
   * Supabase's pooler intermittently refuses the Postgres handshake while the
   * TCP socket opens fine, and it recovers on an immediate retry. Unretried,
   * that threw out of `onModuleInit` — unhandled — killing the process before
   * `app.listen()`, so Railway saw a container that never bound a port and
   * failed the deploy over a database that was up the whole time.
   *
   * Configuration failures (bad password, missing database, TLS) are NOT
   * retried and still crash on the first attempt. See `connect-with-retry.ts`.
   */
  async onModuleInit(): Promise<void> {
    await connectWithRetry(() => this.$connect(), {
      onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
        this.logger.warn(
          `Database connect attempt ${attempt}/${maxAttempts} failed ` +
            `(${prismaErrorCode(error) ?? 'no code'}) — retrying in ${delayMs}ms`,
        );
      },
    });
    this.logger.log('Connected to database');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
