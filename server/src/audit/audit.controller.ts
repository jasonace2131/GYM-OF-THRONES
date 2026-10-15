import { Controller, Get, Query } from '@nestjs/common';
import type { PaginatedData } from '@got/shared';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { AuditService } from './audit.service';
import { ListAuditQueryDto } from './dto/list-audit-query.dto';
import type { AuditEntryView } from './audit.presenter';

/**
 * The audit log — read only, and there is no other verb here on purpose.
 *
 * No POST: entries are written by the actions themselves, never by a client.
 * A route that let a caller author an audit entry would let them author an
 * alibi. No PATCH and no DELETE either: the trail is append-only, which is
 * enforced by this controller having nowhere to send such a request and by the
 * service having no method to serve one.
 *
 * `audit.read` is granted only to ADMIN, only at ALL, and the list is
 * deliberately unscoped — a per-actor slice would let somebody audit everyone
 * except themselves.
 */
@Controller('admin/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermission('audit.read')
  async list(@Query() query: ListAuditQueryDto): Promise<PaginatedData<AuditEntryView>> {
    return this.audit.list(query);
  }

  /**
   * When recording started.
   *
   * Its own route rather than a field on the list, because it is a property of
   * the LOG and not of a page of it — and because the screen needs it even
   * when a filter returns nothing, which is exactly when "there is no record"
   * and "nothing matched" are easiest to confuse.
   */
  @Get('coverage')
  @RequirePermission('audit.read')
  async coverage(): Promise<{ recordingSince: string | null }> {
    return { recordingSince: await this.audit.recordingSince() };
  }
}
