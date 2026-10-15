import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuthUser } from '../auth/auth.types';
import type { AuditService } from '../audit/audit.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AnnouncementImageStorageService } from '../storage/announcement-image-storage.service';
import { AnnouncementsService } from './announcements.service';

const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const IMAGE = `${BASE}announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;
const COVER = `${BASE}announcements/1c7b4d5f-6e3a-4b2c-9d0e-1f2a3b4c5d6e.jpg`;
const ID = '33333333-3333-4333-8333-333333333333';

const ADMIN = { id: '22222222-2222-4222-8222-222222222222', role: 'ADMIN' } as AuthUser;

const RICH = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Holiday hours' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Open ' },
        {
          type: 'text',
          text: 'late',
          marks: [{ type: 'link', attrs: { href: 'https://gymofthrones.ph/hours' } }],
        },
      ],
    },
    { type: 'image', attrs: { src: IMAGE, alt: 'Rack' } },
  ],
};

interface StoredRow {
  id: string;
  title: string;
  content: string;
  contentJson: unknown;
  coverImageUrl: string | null;
  isPinned: boolean;
  authorId: string;
  createdAt: Date;
  updatedAt: Date;
  author: { id: string; firstName: string; lastName: string };
}

function stored(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: ID,
    title: 'Holiday hours',
    content: 'We close at 6pm.',
    contentJson: null,
    coverImageUrl: null,
    isPinned: false,
    authorId: ADMIN.id,
    createdAt: new Date('2026-09-20T01:00:00.000Z'),
    updatedAt: new Date('2026-09-20T01:00:00.000Z'),
    author: { id: ADMIN.id, firstName: 'Ana', lastName: 'Cruz' },
    ...overrides,
  };
}

function setup(existing: StoredRow | null = stored()) {
  const announcement = {
    create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(
        stored({ ...(data as Partial<StoredRow>), contentJson: data['contentJson'] ?? null }),
      ),
    ),
    update: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      const merged = { ...(existing ?? stored()), ...(data as Partial<StoredRow>) };
      if (data['contentJson'] === Prisma.DbNull) merged.contentJson = null;
      return Promise.resolve(merged);
    }),
    findUnique: jest.fn(() => Promise.resolve(existing)),
    delete: jest.fn(() => Promise.resolve(existing)),
  };
  const prisma = { announcement } as unknown as PrismaService;
  const record = jest.fn(() => Promise.resolve());
  const audit = { record } as unknown as AuditService;
  const signUpload = jest.fn();
  const images = {
    publicBaseUrl: BASE,
    enabled: true,
    signUpload,
  } as unknown as AnnouncementImageStorageService;

  return {
    service: new AnnouncementsService(prisma, audit, images),
    announcement,
    record,
    signUpload,
  };
}

const auditCall = (record: jest.Mock): Record<string, unknown> =>
  (record.mock.calls[0] as unknown[])[0] as Record<string, unknown>;

// ─────────────────────────────────────────────────────────────────────────────

describe('AnnouncementsService.create', () => {
  it('stores a plain notice exactly as before, with no JSON', async () => {
    const { service, announcement } = setup();

    await service.create(ADMIN, { title: 'Hours', content: 'We close at 6pm.' });

    const data = announcement.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ title: 'Hours', content: 'We close at 6pm.', isPinned: false });
    expect(data.authorId).toBe(ADMIN.id);
    expect(data.contentJson).toBeUndefined();
    expect(data.coverImageUrl).toBeNull();
  });

  it('stores a rich notice as sanitised JSON plus its DERIVED plain text', async () => {
    const { service, announcement } = setup();

    await service.create(ADMIN, { title: 'Hours', contentJson: RICH });

    const data = announcement.create.mock.calls[0][0].data;
    expect(data.contentJson).toEqual(RICH);
    expect(data.content).toBe('Holiday hours\n\nOpen late');
  });

  it('returns contentJson and coverImageUrl on the wire', async () => {
    const { service } = setup();
    const result = await service.create(ADMIN, {
      title: 'Hours',
      contentJson: RICH,
      coverImageUrl: COVER,
    });
    expect(result.contentJson).toEqual(RICH);
    expect(result.coverImageUrl).toBe(COVER);
  });

  it.each([
    ['a javascript: link', 'javascript:alert(1)'],
    ['a data: link', 'data:text/html,<script>alert(1)</script>'],
  ])('refuses %s with a 400 and writes nothing', async (_label, href) => {
    const { service, announcement, record } = setup();
    const evil = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }],
        },
      ],
    };

    await expect(service.create(ADMIN, { title: 'x', contentJson: evil })).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_CONTENT_INVALID',
      status: 400,
    });
    expect(announcement.create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('refuses an image hotlinked from elsewhere', async () => {
    const { service } = setup();
    const hotlinked = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
        { type: 'image', attrs: { src: 'https://evil.example/x.png' } },
      ],
    };
    await expect(
      service.create(ADMIN, { title: 'x', contentJson: hotlinked }),
    ).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_CONTENT_INVALID',
    });
  });

  it('refuses both content and contentJson — one body, one source of truth', async () => {
    const { service, announcement } = setup();
    await expect(
      service.create(ADMIN, { title: 'x', content: 'plain', contentJson: RICH }),
    ).rejects.toMatchObject({ code: 'ANNOUNCEMENT_CONTENT_INVALID', status: 400 });
    expect(announcement.create).not.toHaveBeenCalled();
  });

  it.each([
    ['another host', 'https://evil.example/cover.jpg'],
    ['an SVG', COVER.replace('.jpg', '.svg')],
    ['plain http', COVER.replace('https://', 'http://')],
    ['an empty string', ''],
  ])('refuses a cover image from %s', async (_label, coverImageUrl) => {
    const { service, announcement } = setup();
    await expect(
      service.create(ADMIN, { title: 'x', content: 'y', coverImageUrl }),
    ).rejects.toMatchObject({ code: 'ANNOUNCEMENT_CONTENT_INVALID', status: 400 });
    expect(announcement.create).not.toHaveBeenCalled();
  });

  it('audits the post with who, what and how', async () => {
    const { service, record } = setup();

    await service.create(ADMIN, {
      title: 'Holiday hours',
      contentJson: RICH,
      coverImageUrl: COVER,
      isPinned: true,
    });

    expect(record).toHaveBeenCalledTimes(1);
    expect(auditCall(record)).toEqual({
      action: 'ANNOUNCEMENT_CREATED',
      actorId: ADMIN.id,
      actorRole: 'ADMIN',
      subjectType: 'Announcement',
      subjectId: ID,
      subjectLabel: 'Holiday hours',
      details: { isPinned: true, format: 'rich', coverImage: true },
    });
  });
});

describe('AnnouncementsService.update', () => {
  it('404s a notice that does not exist', async () => {
    const { service } = setup(null);
    await expect(service.update(ID, { title: 'x' }, ADMIN)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('audits a pin with before and after', async () => {
    const { service, record } = setup(stored({ isPinned: false }));

    await service.update(ID, { isPinned: true }, ADMIN);

    expect(auditCall(record)).toMatchObject({
      action: 'ANNOUNCEMENT_UPDATED',
      subjectId: ID,
      subjectLabel: 'Holiday hours',
      details: { fields: ['isPinned'], isPinned: { before: false, after: true } },
    });
  });

  it('audits a retitle with before and after, and names the new title', async () => {
    const { service, record } = setup();

    await service.update(ID, { title: 'Holiday hours (updated)' }, ADMIN);

    expect(auditCall(record)).toMatchObject({
      subjectLabel: 'Holiday hours (updated)',
      details: {
        fields: ['title'],
        title: { before: 'Holiday hours', after: 'Holiday hours (updated)' },
      },
    });
  });

  it('records only that the body changed — never the text itself', async () => {
    const { service, record } = setup();

    await service.update(ID, { contentJson: RICH }, ADMIN);

    const details = auditCall(record)['details'] as Record<string, unknown>;
    expect(details).toEqual({ fields: ['body'] });
  });

  it('writes nothing to the audit log when nothing changed', async () => {
    const { service, record } = setup(stored({ isPinned: true }));
    await service.update(ID, { isPinned: true, title: 'Holiday hours' }, ADMIN);
    expect(record).not.toHaveBeenCalled();
  });

  it('does not mistake a stored document with reordered keys for an edit', async () => {
    // jsonb stores keys in its own order; a naive JSON.stringify comparison
    // would see every re-save of an untouched notice as a body change.
    const reordered = {
      content: RICH.content
        .map((node) => ({ ...node }))
        .reverse()
        .reverse(),
      type: 'doc',
    };
    const { service, record } = setup(
      stored({ contentJson: reordered, content: 'Holiday hours\n\nOpen late' }),
    );

    await service.update(ID, { contentJson: RICH }, ADMIN);

    expect(record).not.toHaveBeenCalled();
  });

  it('turns a rich notice back into a plain one when given plain content', async () => {
    const { service, announcement } = setup(
      stored({ contentJson: RICH, content: 'Holiday hours\n\nOpen late' }),
    );

    await service.update(ID, { content: 'Just text now.' }, ADMIN);

    const data = announcement.update.mock.calls[0][0].data;
    expect(data.content).toBe('Just text now.');
    expect(data.contentJson).toBe(Prisma.DbNull);
  });

  it('removes a cover when sent null, and leaves it alone when absent', async () => {
    const { service, announcement } = setup(stored({ coverImageUrl: COVER }));

    await service.update(ID, { title: 'New' }, ADMIN);
    expect(announcement.update.mock.calls[0][0].data).not.toHaveProperty('coverImageUrl');

    await service.update(ID, { coverImageUrl: null }, ADMIN);
    expect(announcement.update.mock.calls[1][0].data.coverImageUrl).toBeNull();
  });

  it('refuses an invalid document on edit, with nothing written', async () => {
    const { service, announcement } = setup();
    await expect(
      service.update(ID, { contentJson: { type: 'doc', content: [{ type: 'script' }] } }, ADMIN),
    ).rejects.toMatchObject({ code: 'ANNOUNCEMENT_CONTENT_INVALID' });
    expect(announcement.update).not.toHaveBeenCalled();
  });
});

describe('AnnouncementsService.remove', () => {
  it('audits the delete, naming the notice that went', async () => {
    const { service, record, announcement } = setup(stored({ isPinned: true, contentJson: RICH }));

    const result = await service.remove(ID, ADMIN);

    expect(announcement.delete).toHaveBeenCalledWith({ where: { id: ID } });
    expect(result.title).toBe('Holiday hours');
    expect(auditCall(record)).toEqual({
      action: 'ANNOUNCEMENT_DELETED',
      actorId: ADMIN.id,
      actorRole: 'ADMIN',
      subjectType: 'Announcement',
      subjectId: ID,
      subjectLabel: 'Holiday hours',
      details: { isPinned: true, format: 'rich' },
    });
  });

  it('404s a notice that does not exist, and audits nothing', async () => {
    const { service, record } = setup(null);
    await expect(service.remove(ID, ADMIN)).rejects.toBeInstanceOf(NotFoundException);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('AnnouncementsService uploads', () => {
  it('reports whether the composer may offer images', () => {
    const { service } = setup();
    expect(service.uploadStatus()).toEqual({ enabled: true });
  });

  it('delegates signing to the storage service', async () => {
    const { service, signUpload } = setup();
    signUpload.mockResolvedValue({ path: 'p' });
    await expect(service.signUpload({ contentType: 'image/webp', size: 10 })).resolves.toEqual({
      path: 'p',
    });
    expect(signUpload).toHaveBeenCalledWith('image/webp', 10);
  });
});
