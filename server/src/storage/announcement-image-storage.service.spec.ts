import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';
import { AnnouncementImageStorageService } from './announcement-image-storage.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));

const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const BASE = `${SUPABASE_URL}/storage/v1/object/public/announcements/`;
const KEY_SHAPE =
  /^announcements\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg|png)$/;

function config(serviceKey: string | undefined): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    SUPABASE_URL: `${SUPABASE_URL}/`,
    SUPABASE_SERVICE_KEY: serviceKey,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

function fakeStorage() {
  const bucket = {
    createSignedUploadUrl: jest.fn((path: string) =>
      Promise.resolve({
        data: { signedUrl: `https://signed.example/${path}?token=t`, token: 't', path },
        error: null,
      }),
    ),
    list: jest.fn(),
    remove: jest.fn(() => Promise.resolve({ data: [], error: null })),
  };
  const storage = {
    createBucket: jest.fn(() => Promise.resolve({ data: { name: 'announcements' }, error: null })),
    updateBucket: jest.fn(() => Promise.resolve({ data: { message: 'ok' }, error: null })),
    from: jest.fn(() => bucket),
  };
  (createClient as jest.Mock).mockReturnValue({ storage });
  return { storage, bucket };
}

describe('AnnouncementImageStorageService', () => {
  beforeEach(() => {
    (createClient as jest.Mock).mockReset();
  });

  describe('without SUPABASE_SERVICE_KEY', () => {
    it('is disabled, and says so rather than crashing the boot', async () => {
      const service = new AnnouncementImageStorageService(config(undefined));
      expect(service.enabled).toBe(false);
      expect(createClient).not.toHaveBeenCalled();
      await expect(service.onModuleInit()).resolves.toBeUndefined();
    });

    it('refuses to sign an upload with a named 503', async () => {
      const service = new AnnouncementImageStorageService(config(undefined));
      await expect(service.signUpload('image/webp', 1000)).rejects.toMatchObject({
        code: 'ANNOUNCEMENT_UPLOAD_DISABLED',
        status: 503,
      });
    });

    it('still knows the public base, so stored notices keep validating', () => {
      expect(new AnnouncementImageStorageService(config(undefined)).publicBaseUrl).toBe(BASE);
    });

    it('lists nothing and removes nothing', async () => {
      const service = new AnnouncementImageStorageService(config(undefined));
      await expect(service.listObjects()).resolves.toEqual([]);
      await expect(service.remove(['announcements/x.webp'])).resolves.toBe(0);
    });
  });

  describe('bucket bootstrap', () => {
    it('creates a PUBLIC bucket that takes only JPEG, PNG and WebP up to 5 MB', async () => {
      const { storage } = fakeStorage();
      await new AnnouncementImageStorageService(config('key')).onModuleInit();

      expect(storage.createBucket).toHaveBeenCalledWith('announcements', {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
      expect(storage.updateBucket).not.toHaveBeenCalled();
    });

    it('converges an existing bucket to the same settings — a hand-made private one would break every image', async () => {
      const { storage } = fakeStorage();
      storage.createBucket.mockResolvedValueOnce({
        data: null,
        error: { message: 'The resource already exists' },
      } as never);

      await new AnnouncementImageStorageService(config('key')).onModuleInit();

      expect(storage.updateBucket).toHaveBeenCalledWith('announcements', {
        public: true,
        fileSizeLimit: 5 * 1024 * 1024,
        allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
      });
    });

    it('never throws out of boot, whatever storage says', async () => {
      const { storage } = fakeStorage();
      storage.createBucket.mockRejectedValueOnce(new Error('network down'));
      await expect(
        new AnnouncementImageStorageService(config('key')).onModuleInit(),
      ).resolves.toBeUndefined();
    });
  });

  describe('signUpload', () => {
    it('mints the path itself and returns the public URL the editor inserts', async () => {
      const { bucket } = fakeStorage();
      const service = new AnnouncementImageStorageService(config('key'));

      const upload = await service.signUpload('image/webp', 250_000);

      expect(upload.path).toMatch(KEY_SHAPE);
      expect(upload.path.endsWith('.webp')).toBe(true);
      expect(upload.publicUrl).toBe(`${BASE}${upload.path}`);
      expect(upload.token).toBe('t');
      expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith(upload.path);
    });

    it.each([
      ['image/jpeg', '.jpg'],
      ['image/png', '.png'],
    ])('names a %s upload %s', async (type, ext) => {
      fakeStorage();
      const upload = await new AnnouncementImageStorageService(config('key')).signUpload(type, 10);
      expect(upload.path.endsWith(ext)).toBe(true);
    });

    it.each(['image/svg+xml', 'text/html', 'image/gif'])('refuses %s', async (type) => {
      fakeStorage();
      await expect(
        new AnnouncementImageStorageService(config('key')).signUpload(type, 10),
      ).rejects.toBeInstanceOf(DomainException);
    });

    it('refuses an image over 5 MB before asking storage', async () => {
      const { bucket } = fakeStorage();
      await expect(
        new AnnouncementImageStorageService(config('key')).signUpload(
          'image/webp',
          5 * 1024 * 1024 + 1,
        ),
      ).rejects.toBeInstanceOf(DomainException);
      expect(bucket.createSignedUploadUrl).not.toHaveBeenCalled();
    });

    it('turns a storage failure into a named 503', async () => {
      const { bucket } = fakeStorage();
      bucket.createSignedUploadUrl.mockResolvedValueOnce({
        data: null,
        error: { message: 'boom' },
      } as never);
      await expect(
        new AnnouncementImageStorageService(config('key')).signUpload('image/webp', 10),
      ).rejects.toMatchObject({ code: 'ANNOUNCEMENT_UPLOAD_UNAVAILABLE', status: 503 });
    });
  });

  describe('listObjects', () => {
    it('pages through the prefix and returns full keys with their age, skipping folders', async () => {
      const { bucket } = fakeStorage();
      const page = (n: number, offset: number) =>
        Array.from({ length: n }, (_, i) => ({
          id: `id-${offset + i}`,
          name: `${offset + i}.webp`,
          created_at: '2026-09-20T00:00:00.000Z',
        }));
      bucket.list
        .mockResolvedValueOnce({ data: page(1000, 0), error: null })
        .mockResolvedValueOnce({
          data: [...page(2, 1000), { id: null, name: 'nested', created_at: null }],
          error: null,
        });

      const objects = await new AnnouncementImageStorageService(config('key')).listObjects();

      expect(objects).toHaveLength(1002);
      expect(objects[0]).toEqual({
        key: 'announcements/0.webp',
        createdAt: new Date('2026-09-20T00:00:00.000Z'),
      });
      expect(bucket.list).toHaveBeenNthCalledWith(
        1,
        'announcements',
        expect.objectContaining({ limit: 1000, offset: 0 }),
      );
      expect(bucket.list).toHaveBeenNthCalledWith(
        2,
        'announcements',
        expect.objectContaining({ limit: 1000, offset: 1000 }),
      );
    });

    it('raises when storage refuses the listing — the job must not treat that as "nothing to do"', async () => {
      const { bucket } = fakeStorage();
      bucket.list.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
      await expect(
        new AnnouncementImageStorageService(config('key')).listObjects(),
      ).rejects.toThrow(/denied/);
    });
  });

  describe('remove', () => {
    it('removes in batches and reports how many went', async () => {
      const { bucket } = fakeStorage();
      const keys = Array.from({ length: 250 }, (_, i) => `announcements/${i}.webp`);

      const removed = await new AnnouncementImageStorageService(config('key')).remove(keys);

      expect(removed).toBe(250);
      expect(bucket.remove).toHaveBeenCalledTimes(3);
      expect(bucket.remove).toHaveBeenNthCalledWith(1, keys.slice(0, 100));
    });

    it('does not call storage for an empty list', async () => {
      const { bucket } = fakeStorage();
      await expect(new AnnouncementImageStorageService(config('key')).remove([])).resolves.toBe(0);
      expect(bucket.remove).not.toHaveBeenCalled();
    });
  });
});
