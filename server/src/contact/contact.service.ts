import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Lead, LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../notifications/email.service';
import { SystemNotificationsService } from '../notifications/system-notifications.service';
import { hashIp } from '../checkin/origin';
import type { Env } from '../config/env.validation';
import type { SubmitLeadDto } from './dto/submit-lead.dto';

export interface LeadView {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
  source: string;
  status: LeadStatus;
  assignedToId: string | null;
  notes: string | null;
  emailSent: boolean;
  convertedUserId: string | null;
  createdAt: string;
}

function toView(row: Lead): LeadView {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    message: row.message,
    source: row.source,
    status: row.status,
    assignedToId: row.assignedToId,
    notes: row.notes,
    emailSent: row.emailSent,
    convertedUserId: row.convertedUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);
  private readonly ipPepper: string;
  private readonly notifyTo: string | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly notifications: SystemNotificationsService,
    config: ConfigService<Env, true>,
  ) {
    this.ipPepper = config.get('IP_HASH_PEPPER', { infer: true });
    // Where enquiries land. Falls back to the sender when unset, which is the
    // common single-inbox case for a small gym.
    this.notifyTo =
      config.get('CONTACT_NOTIFY_EMAIL', { infer: true }) ??
      config.get('RESEND_FROM', { infer: true }) ??
      null;
  }

  /**
   * Take an enquiry.
   *
   * ═════════════════════════════════════════════════════════════════════════
   * STORE FIRST, THEN SEND. THE ORDER IS THE WHOLE DESIGN.
   *
   * An email provider is a third party that will be down at some point. If
   * the send came first, or if a failure threw, that outage would lose the
   * enquiry — the one thing this endpoint exists to prevent. The row is
   * committed before Resend is called, the send is best-effort, and
   * `emailSent` records the truth so the screen can flag anything that did
   * not reach an inbox.
   *
   * A silent success where the gym never learns of the enquiry is far worse
   * than a visible one they can chase from the CRM.
   * ═════════════════════════════════════════════════════════════════════════
   */
  async submit(dto: SubmitLeadDto, ip: string | undefined): Promise<{ id: string }> {
    /*
     * THE HONEYPOT IS ACCEPTED, NOT REJECTED.
     *
     * Returning a 400 tells the bot which field gave it away, and it comes
     * back with that one blank. A 200 with nothing written teaches it
     * nothing, costs a real user nothing, and keeps the table clean.
     */
    if (dto.website !== undefined && dto.website.trim() !== '') {
      this.logger.warn('contact form honeypot tripped — discarded');
      return { id: 'discarded' };
    }

    const lead = await this.prisma.lead.create({
      data: {
        name: dto.name,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        message: dto.message ?? null,
        source: 'WEBSITE',
        originIpHash: ip === undefined ? null : hashIp(ip, this.ipPepper),
      },
      select: { id: true, name: true, email: true, phone: true, message: true },
    });

    let emailed = false;
    if (this.notifyTo !== null && this.email.enabled) {
      try {
        await this.email.sendLeadNotification(this.notifyTo, {
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          message: lead.message,
        });
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { emailSent: true },
        });
        emailed = true;
      } catch (caught) {
        // Logged, never thrown. The enquiry is already safe.
        this.logger.error(`lead ${lead.id} saved but not emailed`, caught as Error);
      }
    }

    /*
     * THE IN-CONSOLE NOTICE, raised AFTER the row is committed and never
     * awaited for its result — `raise()` swallows its own failures by
     * contract, for exactly the reason the block above logs rather than
     * throws: an enquiry must survive every downstream courtesy failing.
     *
     * The severity carries the email's fate. An enquiry the gym was never
     * emailed about is the one somebody has to notice IN the console, because
     * nothing else is going to tell them — which is what `emailSent` was
     * already recorded for, now surfaced somewhere a person looks.
     */
    await this.notifications.raise({
      kind: 'LEAD_RECEIVED',
      severity: emailed ? 'INFO' : 'WARNING',
      title: `New enquiry from ${lead.name}`,
      body: emailed
        ? (lead.message ?? 'No message left.')
        : `No notification email was sent, so this is the only record you will see. ${
            lead.message ?? 'No message left.'
          }`,
      linkPath: '/admin/leads',
      subjectType: 'Lead',
      subjectId: lead.id,
    });

    return { id: lead.id };
  }

  async list(status?: LeadStatus): Promise<LeadView[]> {
    const rows = await this.prisma.lead.findMany({
      where: status === undefined ? {} : { status },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    return rows.map(toView);
  }

  /**
   * Move a lead along, or write a note on it.
   *
   * `convertedAt` is set here rather than by the caller: `Lead_converted_shape`
   * ties it to the status in both directions, so letting a client supply one
   * would mean a 4xx for a combination it had no way to know was illegal.
   */
  async update(
    id: string,
    patch: { status?: LeadStatus; assignedToId?: string | null; notes?: string | null },
    now: Date = new Date(),
  ): Promise<LeadView> {
    const data: Prisma.LeadUpdateInput = {
      ...(patch.notes === undefined ? {} : { notes: patch.notes }),
      ...(patch.assignedToId === undefined
        ? {}
        : {
            assignedTo:
              patch.assignedToId === null
                ? { disconnect: true }
                : { connect: { id: patch.assignedToId } },
          }),
    };

    if (patch.status !== undefined) {
      data.status = patch.status;
      data.convertedAt = patch.status === 'CONVERTED' ? now : null;
    }

    return toView(await this.prisma.lead.update({ where: { id }, data }));
  }
}
