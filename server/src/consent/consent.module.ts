import { Module } from '@nestjs/common';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

/**
 * Nothing imported: `PrismaModule` is `@Global`, `ConfigModule` is registered
 * globally in `app.module.ts`, and the guard chain arrives as `APP_GUARD`.
 *
 * Exported because `MembersService` needs the standing when it presents a
 * member to staff — "has this person signed the waiver" is a question the
 * front desk asks before the member reaches the floor, not only one the
 * portal asks itself.
 */
@Module({
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
