import { describe, expect, it, vi } from 'vitest';
import {
  RESIZE_MAX_WIDTH,
  fitWithin,
  imageFileProblem,
  prepareImage,
  uploadAnnouncementImage,
  type ImagePipeline,
} from './imageUpload';

const MB = 1024 * 1024;

/** A pipeline that "encodes" to a blob of a chosen type and size. */
function fakePipeline(options: {
  width: number;
  height: number;
  /** What the browser hands back per requested type — Safari returns PNG for WebP. */
  produces?: (type: string, quality: number) => { type: string; size: number };
}): ImagePipeline & { encode: ReturnType<typeof vi.fn> } {
  const produces = options.produces ?? ((type) => ({ type, size: 300_000 }));
  return {
    decode: vi.fn(() =>
      Promise.resolve({ width: options.width, height: options.height, source: {} }),
    ),
    encode: vi.fn((_image: unknown, _w: number, _h: number, type: string, quality: number) => {
      const out = produces(type, quality);
      return Promise.resolve(new Blob([new Uint8Array(out.size)], { type: out.type }));
    }),
  };
}

const file = (type: string, size = 2 * MB): File =>
  new File([new Uint8Array(size)], 'photo', { type });

describe('fitWithin', () => {
  it('scales a wide photo down to the width cap, keeping its shape', () => {
    expect(fitWithin(4032, 3024, RESIZE_MAX_WIDTH)).toEqual({ width: 1600, height: 1200 });
  });

  it('never scales up', () => {
    expect(fitWithin(800, 600, RESIZE_MAX_WIDTH)).toEqual({ width: 800, height: 600 });
  });

  it('never returns a zero dimension', () => {
    expect(fitWithin(16000, 5, RESIZE_MAX_WIDTH)).toEqual({ width: 1600, height: 1 });
  });
});

describe('imageFileProblem', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (type) => {
    expect(imageFileProblem({ type, size: 3 * MB })).toBeNull();
  });

  it.each(['image/svg+xml', 'image/gif', 'image/heic', 'text/html', ''])('refuses %p', (type) => {
    expect(imageFileProblem({ type, size: 1000 })).toMatch(/JPEG, PNG or WebP/);
  });

  it('refuses a source file too big to be worth decoding', () => {
    expect(imageFileProblem({ type: 'image/jpeg', size: 30 * MB })).toMatch(/too large/i);
  });
});

describe('prepareImage', () => {
  it('re-encodes to WebP at the capped size — which also strips EXIF, GPS included', async () => {
    const pipeline = fakePipeline({ width: 4000, height: 3000 });

    const prepared = await prepareImage(file('image/jpeg'), pipeline);

    expect(prepared).toMatchObject({ type: 'image/webp', width: 1600, height: 1200 });
    expect(pipeline.encode).toHaveBeenCalledWith(expect.anything(), 1600, 1200, 'image/webp', 0.85);
  });

  it('falls back to JPEG when the browser cannot encode WebP', async () => {
    const pipeline = fakePipeline({
      width: 1200,
      height: 800,
      produces: (type) => ({ type: type === 'image/webp' ? 'image/png' : type, size: 200_000 }),
    });

    const prepared = await prepareImage(file('image/png'), pipeline);

    expect(prepared.type).toBe('image/jpeg');
  });

  it('tries a lower quality before giving up on size', async () => {
    const pipeline = fakePipeline({
      width: 1600,
      height: 1200,
      produces: (type, quality) => ({ type, size: quality > 0.7 ? 6 * MB : 1 * MB }),
    });

    const prepared = await prepareImage(file('image/webp'), pipeline);

    expect(prepared.blob.size).toBe(1 * MB);
  });

  it('refuses an image that will not fit under 5 MB at any quality', async () => {
    const pipeline = fakePipeline({
      width: 1600,
      height: 1200,
      produces: (type) => ({ type, size: 6 * MB }),
    });
    await expect(prepareImage(file('image/webp'), pipeline)).rejects.toThrow(/5 MB/);
  });

  it('refuses a file the browser cannot decode', async () => {
    const pipeline = fakePipeline({ width: 10, height: 10 });
    pipeline.decode = vi.fn(() => Promise.reject(new Error('bad data')));
    await expect(prepareImage(file('image/jpeg'), pipeline)).rejects.toThrow(/could not be read/i);
  });
});

describe('uploadAnnouncementImage', () => {
  const signed = {
    path: 'announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp',
    uploadUrl: 'https://abcdefgh.supabase.co/storage/v1/object/upload/sign/x?token=t',
    token: 't',
    publicUrl:
      'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp',
  };

  it('signs for the RESIZED bytes, PUTs them straight to storage, and returns what to insert', async () => {
    const sign = vi.fn(() => Promise.resolve(signed));
    const put = vi.fn(() => Promise.resolve({ ok: true }));

    const uploaded = await uploadAnnouncementImage(file('image/jpeg', 4 * MB), {
      pipeline: fakePipeline({ width: 3200, height: 1800 }),
      sign,
      put,
    });

    expect(sign).toHaveBeenCalledWith({ contentType: 'image/webp', size: 300_000 });
    expect(put).toHaveBeenCalledWith(signed.uploadUrl, expect.any(Blob), 'image/webp');
    expect(uploaded).toEqual({ src: signed.publicUrl, width: 1600, height: 900 });
  });

  it('refuses an SVG before resizing or asking the server anything', async () => {
    const sign = vi.fn();
    const pipeline = fakePipeline({ width: 10, height: 10 });
    await expect(
      uploadAnnouncementImage(file('image/svg+xml'), { pipeline, sign, put: vi.fn() }),
    ).rejects.toThrow(/JPEG, PNG or WebP/);
    expect(pipeline.decode).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it('says so plainly when storage refuses the bytes', async () => {
    await expect(
      uploadAnnouncementImage(file('image/png'), {
        pipeline: fakePipeline({ width: 100, height: 100 }),
        sign: () => Promise.resolve(signed),
        put: () => Promise.resolve({ ok: false }),
      }),
    ).rejects.toThrow(/did not upload/i);
  });
});
