import { Module } from '@nestjs/common';
import { MembershipModule } from '../membership/membership.module';
import { PaymentsModule } from '../payments/payments.module';
import { CatalogueModule } from '../catalogue/catalogue.module';
import { MeCheckInsService } from '../me/me-check-ins.service';
import { AdminAssistantController } from './admin-assistant.controller';
import { AssistantController } from './assistant.controller';
import { AssistantService } from './assistant.service';
import { AssistantSettingsService } from './assistant-settings.service';
import { GeminiModule } from './gemini.module';

/**
 * The assistant reuses the SAME services the /me routes do, rather than
 * querying Prisma itself. That is what keeps a tool's answer identical to the
 * screen's — an assistant that computed its own access verdict would
 * eventually tell a member they can get in while the door says otherwise.
 *
 * Gemini itself comes from `GeminiModule`: one client, one rotation, one
 * quota ledger, shared with the coach's workout-plan suggester.
 */
@Module({
  imports: [MembershipModule, PaymentsModule, CatalogueModule, GeminiModule],
  controllers: [AssistantController, AdminAssistantController],
  providers: [AssistantService, AssistantSettingsService, MeCheckInsService],
})
export class AssistantModule {}
