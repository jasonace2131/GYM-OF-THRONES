import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { LeadStatus } from '@prisma/client';
import { Public } from '../auth/decorators/public.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { ContactService, type LeadView } from './contact.service';
import { SubmitLeadDto } from './dto/submit-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';

/**
 * The public contact form.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST PUBLIC POST IN THIS CODEBASE.
 *
 * The four existing `@Public()` routes are all GETs that read configuration
 * or the price list. This one WRITES, from an unauthenticated caller, which
 * means the usual defences are absent: no AuthGuard to identify anyone, no
 * PermissionsGuard, and `UserThrottlerGuard` falls back to keying on IP
 * because there is no user to key on.
 *
 * What is left is: a tight per-IP rate limit, a DTO that is the security
 * boundary rather than a convenience, a honeypot, and CHECK constraints on
 * every column. `@Public()` and `@RequirePermission` on the same route is a
 * wiring error PermissionsGuard throws on, so the split below is two
 * controllers rather than one with mixed decorators.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Controller('contact')
export class ContactController {
  constructor(private readonly contact: ContactService) {}

  /**
   * 3 a minute per IP, 20 an hour's worth on the origin bucket.
   *
   * A person enquires once. Three allows for a typo and a resubmit; anything
   * beyond it is a script. Deliberately far below the default 100/min, since
   * every call here writes a row and may send an email.
   */
  @Post()
  @Public()
  @HttpCode(HttpStatus.OK)
  @Throttle({
    default: { limit: 3, ttl: 60_000 },
    origin: { limit: 20, ttl: 60_000 },
  })
  async submit(@Body() dto: SubmitLeadDto, @Req() request: Request): Promise<{ received: true }> {
    // `app.set('trust proxy', 1)` in main.ts makes this the client rather
    // than the load balancer. Hashed before storage, never kept raw.
    await this.contact.submit(dto, request.ip);

    /*
     * ALWAYS THE SAME ANSWER, INCLUDING FOR A DISCARDED HONEYPOT SUBMISSION.
     *
     * Returning the lead id, or a different shape when the honeypot trips,
     * would tell a bot which of its attempts landed. The person on the form
     * needs "we got it" and nothing else.
     */
    return { received: true };
  }
}

/**
 * The CRM side. `member.read` rather than a new key: anyone who may look at
 * the member roster may look at the people asking to join it, and a
 * `lead.read` grant that every staff role would hold immediately is a row in
 * the permission table that never says no to anybody.
 */
@Controller('admin/leads')
export class AdminLeadsController {
  constructor(private readonly contact: ContactService) {}

  @Get()
  @RequirePermission('member.read')
  async list(@Query('status') status?: LeadStatus): Promise<LeadView[]> {
    return this.contact.list(status);
  }

  /** Working a lead: assign it, note it, move it along. */
  @Patch(':id')
  @RequirePermission('member.update')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateLeadDto,
  ): Promise<LeadView> {
    return this.contact.update(id, dto);
  }
}
