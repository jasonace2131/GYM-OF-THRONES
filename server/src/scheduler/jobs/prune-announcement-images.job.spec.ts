import type { PrismaService } from '../../prisma/prisma.service';
import type { AnnouncementImageStorageService } from '../../storage/announcement-image-storage.service';
import { PruneAnnouncementImagesJob, orphanedImageKeys } from './prune-announcement-images.job';

const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const NOW = new Date('2026-09-25T19:45:00.000Z');
const HOUR = 3_600_000;

const key = (n: number): string =>
  `announcements/${String(n).padStart(8, '0')}-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;
const url = (n: number): string => `${BASE}${key(n)}`;
const aged = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR);

describe('orphanedImageKeys', () => {
  const cutoff = aged(24);

  it('takes objects older than the cutoff that nothing references', () => {
    const objects = [
      { key: key(1), createdAt: aged(48) }, // old, unreferenced → goes
      { key: key(2), createdAt: aged(48) }, // old, referenced → stays
      { key: key(3), createdAt: aged(2) }, // young, unreferenced → stays (still being composed)
    ];
    expect(orphanedImageKeys(objects, new Set([key(2)]), cutoff)).toEqual([key(1)]);
  });

  it('keeps an object exactly at the cutoff — strictly older only', () => {
    expect(orphanedImageKeys([{ key: key(1), createdAt: cutoff }], new Set(), cutoff)).toEqual([]);
  });
});

describe('PruneAnnouncementImagesJob', () => {
  function setup(options: {
    enabled?: boolean;
    objects?: Array<{ key: string; createdAt: Date }>;
    rows?: Array<{ contentJson: unknown; coverImageUrl: string | null }>;
  }) {
    const findMany = jest.fn(() => Promise.resolve(options.rows ?? []));
    const prisma = { announcement: { findMany } } as unknown as PrismaService;
    const listObjects = jest.fn(() => Promise.resolve(options.objects ?? []));
    const remove = jest.fn((keys: string[]) => Promise.resolve(keys.length));
    const images = {
      enabled: options.enabled ?? true,
      publicBaseUrl: BASE,
      listObjects,
      remove,
    } as unknown as AnnouncementImageStorageService;
    return { job: new PruneAnnouncementImagesJob(prisma, images), findMany, listObjects, remove };
  }

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs nightly, after pruneEphemera', () => {
    const { job } = setup({});
    expect(job.name).toBe('pruneAnnouncementImages');
    expect(job.cronExpression).toBe('45 03 * * *');
  });

  it('does nothing at all when storage is disabled', async () => {
    const { job, listObjects, findMany, remove } = setup({ enabled: false });
    await job.run();
    expect(listObjects).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps images referenced from a body or as a cover, and removes the day-old rest', async () => {
    const { job, remove } = setup({
      objects: [1, 2, 3, 4].map((n) => ({ key: key(n), createdAt: aged(30) })),
      rows: [
        {
          contentJson: {
            type: 'doc',
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
              {
                type: 'bulletList',
                content: [
                  { type: 'listItem', content: [{ type: 'image', attrs: { src: url(1) } }] },
                ],
              },
            ],
          },
          coverImageUrl: null,
        },
        { contentJson: null, coverImageUrl: url(2) },
      ],
    });

    await job.run();

    expect(remove).toHaveBeenCalledWith([key(3), key(4)]);
  });

  it('never touches an upload from the last 24 hours — it may be in an unsaved draft', async () => {
    const { job, remove } = setup({ objects: [{ key: key(1), createdAt: aged(23) }] });
    await job.run();
    expect(remove).not.toHaveBeenCalled();
  });

  it('reads the references AFTER listing, so a notice saved mid-run protects its image', async () => {
    const order: string[] = [];
    const { job, listObjects, findMany } = setup({
      objects: [{ key: key(1), createdAt: aged(30) }],
    });
    listObjects.mockImplementation(() => {
      order.push('list');
      return Promise.resolve([{ key: key(1), createdAt: aged(30) }]);
    });
    findMany.mockImplementation(() => {
      order.push('references');
      return Promise.resolve([]);
    });

    await job.run();

    expect(order).toEqual(['list', 'references']);
  });

  it('skips the database entirely when nothing in the bucket is old enough', async () => {
    const { job, findMany } = setup({ objects: [{ key: key(1), createdAt: aged(1) }] });
    await job.run();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('lets a listing failure raise, so the scheduler logs it', async () => {
    const { job, listObjects, remove } = setup({});
    listObjects.mockRejectedValueOnce(new Error('could not list'));
    await expect(job.run()).rejects.toThrow('could not list');
    expect(remove).not.toHaveBeenCalled();
  });
});
