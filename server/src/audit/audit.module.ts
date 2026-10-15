import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * `@Global`, for the same reason `NotificationsModule` is: the producers are
 * scattered across almost every feature module — payments, front desk, users,
 * catalogue, config — and none of them has any other relationship with
 * auditing. Making each import this module would put an audit dependency in
 * the import list of most of the application, for one method call.
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
