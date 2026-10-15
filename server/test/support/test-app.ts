import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { INestApplication, Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import type { PrismaClient } from '@prisma/client';
import { ensureMigratedAndSeeded, loadTestEnv } from './db';
import { AppModule } from '../../src/app.module';
import { JwtVerifierService } from '../../src/auth/jwt-verifier.service';
import { HttpExceptionFilter } from '../../src/common/filters/http-exception.filter';
import { TransformInterceptor } from '../../src/common/interceptors/transform.interceptor';
import { buildCorsOptions } from '../../src/config/cors.options';
import { GymConfigService } from '../../src/config/gym.config';
import { PrismaService } from '../../src/prisma/prisma.service';
import { AuthFixture } from './auth-fixture';

export interface TestApp {
  app: INestApplication;
  prisma: PrismaClient;
  fixture: AuthFixture;
  close(): Promise<void>;
}

export interface CreateTestAppOptions {
  /**
   * Defaults to 'off'. The global limit is 100/60s and a suite of forty
   * requests from one fixture user would start flaking the day the throttler
   * became real. Only throttling.e2e-spec.ts opts back in.
   */
  throttling?: 'on' | 'off';
  /**
   * Extra controllers mounted on the root testing module. Exists for
   * idempotency.e2e-spec.ts, which needs an @Idempotent() route and chunk 0
   * ships no money write.
   */
  controllers?: Type<unknown>[];
  /**
   * Providers replaced with test doubles. Exists for the staff-invitation
   * suite, which must never send a real email (EmailService) or create a real
   * Supabase account (SupabaseAdminService) — whatever keys the machine
   * running the suite happens to have configured.
   */
  overrides?: ReadonlyArray<{ provide: unknown; useValue: unknown }>;
}

/** A storage that never blocks. Keeps the guard in the chain and its maths out of the way. */
const PASS_THROUGH_STORAGE = {
  increment: (): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> => Promise.resolve({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 }),
};

/**
 * Boots AppModule with the same global pipeline main.ts builds.
 *
 * LoggingInterceptor is deliberately omitted — it is pure noise in a test run
 * and nothing asserts on it. Every other stage is identical, and CORS comes
 * from buildCorsOptions so the header lists cannot diverge from production.
 */
export async function createTestApp(options: CreateTestAppOptions = {}): Promise<TestApp> {
  loadTestEnv();
  await ensureMigratedAndSeeded();

  const fixture = await AuthFixture.create();

  const builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: options.controllers ?? [],
  })
    .overrideProvider(JwtVerifierService)
    .useValue(fixture.verifier);

  if (options.throttling !== 'on') {
    builder.overrideProvider(ThrottlerStorage).useValue(PASS_THROUGH_STORAGE);
  }

  for (const override of options.overrides ?? []) {
    builder.overrideProvider(override.provide).useValue(override.useValue);
  }

  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();

  app.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enableCors(buildCorsOptions(process.env['CORS_ORIGIN'] ?? 'http://localhost:3000'));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new TransformInterceptor());

  await app.init();

  // Resolving it here turns a missing §4.13 variable into one loud line at
  // boot rather than a confusing failure three assertions deep.
  app.get(GymConfigService, { strict: false });

  const prisma = app.get(PrismaService, { strict: false });

  return {
    app,
    prisma,
    fixture,
    close: async (): Promise<void> => {
      await app.close();
      await fixture.close();
    },
  };
}
