import { ContactService } from './contact.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { EmailService } from '../notifications/email.service';
import type { SystemNotificationsService } from '../notifications/system-notifications.service';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';

const config = {
  get: (key: string) =>
    key === 'IP_HASH_PEPPER' ? 'test-pepper' : key === 'CONTACT_NOTIFY_EMAIL' ? 'gym@test' : undefined,
} as unknown as ConfigService<Env, true>;

describe('ContactService.submit', () => {
  const create = jest.fn();
  const update = jest.fn();
  const prisma = { lead: { create, update } } as unknown as PrismaService;

  const sendLeadNotification = jest.fn();
  const email = { enabled: true, sendLeadNotification } as unknown as EmailService;

  const raise = jest.fn();
  const notifications = { raise } as unknown as SystemNotificationsService;

  const service = new ContactService(prisma, email, notifications, config);

  beforeEach(() => {
    create.mockReset();
    update.mockReset();
    sendLeadNotification.mockReset();
    raise.mockReset();
    raise.mockResolvedValue(undefined);
    create.mockResolvedValue({
      id: 'lead-1',
      name: 'Juan',
      email: 'juan@example.com',
      phone: null,
      message: 'How much monthly?',
    });
    update.mockResolvedValue({});
    sendLeadNotification.mockResolvedValue(undefined);
  });

  it('stores the enquiry and notifies the gym', async () => {
    await service.submit({ name: 'Juan', email: 'juan@example.com' }, '203.0.113.4');

    expect(create).toHaveBeenCalled();
    expect(sendLeadNotification).toHaveBeenCalledWith('gym@test', expect.objectContaining({
      name: 'Juan',
    }));
    expect(update).toHaveBeenCalledWith({ where: { id: 'lead-1' }, data: { emailSent: true } });
    // The console board learns about it too, at INFO — the email went out, so
    // this is a convenience rather than the only trace of the enquiry.
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'LEAD_RECEIVED',
        severity: 'INFO',
        subjectType: 'Lead',
        subjectId: 'lead-1',
      }),
    );
  });

  /**
   * THE ORDER IS THE WHOLE DESIGN.
   *
   * An email provider will be down at some point. If the send came first, or
   * if a failure propagated, that outage would lose the enquiry — the one
   * thing this endpoint exists to prevent. A visible failure the gym can
   * chase from the CRM beats a silent one nobody learns about.
   */
  it('keeps the lead when the notification fails', async () => {
    sendLeadNotification.mockRejectedValue(new Error('Resend down'));

    await expect(service.submit({ name: 'Juan', email: 'j@e.com' }, undefined)).resolves.toEqual({
      id: 'lead-1',
    });

    expect(create).toHaveBeenCalled();
    // Never flipped to true, so the screen can flag it as unseen.
    expect(update).not.toHaveBeenCalled();
    // WARNING, not INFO. Nobody was emailed, so the console board is the ONLY
    // place this enquiry will ever announce itself.
    expect(raise).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'LEAD_RECEIVED', severity: 'WARNING' }),
    );
  });

  it('stores the lead even with email disabled entirely', async () => {
    const offline = new ContactService(
      prisma,
      { enabled: false, sendLeadNotification } as unknown as EmailService,
      notifications,
      config,
    );

    await offline.submit({ name: 'Juan', phone: '09171234567' }, undefined);

    expect(create).toHaveBeenCalled();
    expect(sendLeadNotification).not.toHaveBeenCalled();
  });

  /**
   * A 400 tells the bot which field gave it away, and it returns with that
   * one blank. Accepting and discarding teaches it nothing, costs a real
   * visitor nothing, and keeps the table clean.
   */
  it('silently discards a honeypot submission without writing a row', async () => {
    const result = await service.submit(
      { name: 'Bot', email: 'bot@spam.example', website: 'http://spam.example' },
      '203.0.113.9',
    );

    expect(create).not.toHaveBeenCalled();
    expect(sendLeadNotification).not.toHaveBeenCalled();
    // A discarded bot submission must not put a row on the staff board either
    // — that would hand the spammer the attention the honeypot exists to deny.
    expect(raise).not.toHaveBeenCalled();
    expect(result).toEqual({ id: 'discarded' });
  });

  it('treats a whitespace-only honeypot as untouched', async () => {
    await service.submit({ name: 'Juan', email: 'j@e.com', website: '   ' }, undefined);
    expect(create).toHaveBeenCalled();
  });

  it('hashes the origin address rather than storing it', async () => {
    await service.submit({ name: 'Juan', email: 'j@e.com' }, '203.0.113.4');

    const [args] = create.mock.calls[0] as [{ data: { originIpHash: string | null } }];
    expect(args.data.originIpHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args.data)).not.toContain('203.0.113.4');
  });

  it('records no address when there is none', async () => {
    await service.submit({ name: 'Juan', email: 'j@e.com' }, undefined);

    const [args] = create.mock.calls[0] as [{ data: { originIpHash: string | null } }];
    expect(args.data.originIpHash).toBeNull();
  });
});

describe('ContactService.update', () => {
  const update = jest.fn();
  const prisma = { lead: { update } } as unknown as PrismaService;
  const service = new ContactService(
    prisma,
    { enabled: false } as unknown as EmailService,
    { raise: jest.fn() } as unknown as SystemNotificationsService,
    config,
  );

  beforeEach(() => {
    update.mockReset();
    update.mockResolvedValue({
      id: 'l1',
      name: 'Juan',
      email: null,
      phone: null,
      message: null,
      source: 'WEBSITE',
      status: 'CONVERTED',
      assignedToId: null,
      notes: null,
      emailSent: true,
      convertedUserId: null,
      createdAt: new Date(),
    });
  });

  /**
   * `Lead_converted_shape` ties status and timestamp together in BOTH
   * directions. Deriving it here rather than accepting it from the client is
   * what stops a caller producing a combination the database refuses, for a
   * rule they had no way to know existed.
   */
  it('stamps convertedAt when a lead converts', async () => {
    const now = new Date('2026-09-01T02:00:00.000Z');
    await service.update('l1', { status: 'CONVERTED' }, now);

    const [args] = update.mock.calls[0] as [{ data: { convertedAt: Date | null } }];
    expect(args.data.convertedAt).toEqual(now);
  });

  it('clears convertedAt when a lead moves back out of CONVERTED', async () => {
    await service.update('l1', { status: 'LOST' });

    const [args] = update.mock.calls[0] as [{ data: { convertedAt: Date | null } }];
    expect(args.data.convertedAt).toBeNull();
  });

  it('leaves convertedAt alone when only a note changes', async () => {
    await service.update('l1', { notes: 'Called, will visit Saturday.' });

    const [args] = update.mock.calls[0] as [{ data: Record<string, unknown> }];
    expect(args.data).not.toHaveProperty('convertedAt');
  });
});
