import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { buildCorsOptions } from './config/cors.options';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap(): Promise<void> {
  // Typed as NestExpressApplication because `app.set` does not exist on the
  // platform-agnostic INestApplication. This is a compile error, not a
  // runtime one, and it is the usual way this change stalls.
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Security headers
  app.use(helmet());

  // Trust one proxy hop, so `req.ip` is the client rather than the load
  // balancer. UserThrottlerGuard keys @Public() routes on it, so getting this
  // wrong collapses every anonymous caller onto one shared budget. Must be set
  // before enableCors.
  app.set('trust proxy', 1);

  // Global API prefix and versioning
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // CORS — only allow configured origins
  const corsOrigin = process.env['CORS_ORIGIN'] ?? 'http://localhost:3000';
  app.enableCors(buildCorsOptions(corsOrigin));

  // Global pipes — validate and transform all incoming DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true, // Strip properties not in DTO
      forbidNonWhitelisted: true, // Throw on unknown properties
      transform: true, // Auto-transform payloads to DTO instances
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global exception filter — standardizes all error responses
  app.useGlobalFilters(new HttpExceptionFilter());

  // Global interceptors — logging and response transformation
  app.useGlobalInterceptors(new LoggingInterceptor(), new TransformInterceptor());

  const port = process.env['PORT'] ?? 4000;
  await app.listen(port);

  console.info(`🚀 Server running on http://localhost:${port}/api/v1`);
}

bootstrap();
