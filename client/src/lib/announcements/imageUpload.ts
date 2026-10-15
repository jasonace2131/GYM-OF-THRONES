import {
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  ANNOUNCEMENT_IMAGE_TYPES,
  type AnnouncementImageUpload,
} from '@got/shared';

/**
 * Getting an image from an admin's disk (or clipboard) into a notice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * RESIZED AND RE-ENCODED IN THE BROWSER, THEN PUT STRAIGHT TO STORAGE.
 *
 * A phone photo is 4000 px and 3–8 MB, and it will be downloaded by every
 * member who opens the dashboard on gym wifi. So it is drawn onto a canvas at
 * most `RESIZE_MAX_WIDTH` wide and re-encoded as WebP (JPEG where the browser
 * cannot encode WebP — Safari hands back PNG instead). Re-encoding has a
 * second, quieter benefit: a canvas carries no EXIF, so a photo's GPS
 * position never reaches the public bucket.
 *
 * The bytes never touch our API. The server signs a one-shot URL for the
 * declared type and size (and mints the path itself); the browser PUTs to it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The canvas work is behind `ImagePipeline` so the decisions here — size,
 * format fallback, quality ladder, ordering — are unit-tested without a
 * canvas, which jsdom does not have. `browserPipeline` is the real one.
 */

/** Wide enough for a desktop dashboard at 2x, small enough for a phone on 4G. */
export const RESIZE_MAX_WIDTH = 1600;

/** A source file larger than this is not worth decoding in a browser tab. */
const SOURCE_MAX_BYTES = 25 * 1024 * 1024;

/** Tried in order until the result fits under the bucket's 5 MB limit. */
const QUALITIES = [0.85, 0.7, 0.55] as const;

export interface DecodedImage {
  width: number;
  height: number;
  /** Whatever the pipeline needs to draw it — an ImageBitmap in the browser. */
  source: unknown;
}

export interface ImagePipeline {
  decode(file: Blob): Promise<DecodedImage>;
  encode(
    image: DecodedImage,
    width: number,
    height: number,
    type: 'image/webp' | 'image/jpeg',
    quality: number,
  ): Promise<Blob>;
  release?(image: DecodedImage): void;
}

export interface PreparedImage {
  blob: Blob;
  type: 'image/webp' | 'image/jpeg';
  width: number;
  height: number;
}

export interface UploadedImage {
  /** The public URL — the only kind of image `src` the API accepts. */
  src: string;
  width: number;
  height: number;
}

/** Scale down to `maxWidth`, never up, keeping the aspect ratio. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth: number,
): { width: number; height: number } {
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

/** Why this file cannot be used, in words for the admin — or null. */
export function imageFileProblem(file: { type: string; size: number }): string | null {
  if (!(ANNOUNCEMENT_IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return 'Choose a JPEG, PNG or WebP image.';
  }
  if (file.size > SOURCE_MAX_BYTES) {
    return 'That image is too large to use. Pick one under 25 MB.';
  }
  return null;
}

export async function prepareImage(file: Blob, pipeline: ImagePipeline): Promise<PreparedImage> {
  let decoded: DecodedImage;
  try {
    decoded = await pipeline.decode(file);
  } catch {
    throw new Error('That image could not be read. Try saving it as a JPEG or PNG first.');
  }

  try {
    const { width, height } = fitWithin(decoded.width, decoded.height, RESIZE_MAX_WIDTH);
    let type: PreparedImage['type'] = 'image/webp';

    for (const quality of QUALITIES) {
      let blob = await pipeline.encode(decoded, width, height, type, quality);
      if (type === 'image/webp' && blob.type !== 'image/webp') {
        // This browser cannot encode WebP and quietly gave back something else.
        type = 'image/jpeg';
        blob = await pipeline.encode(decoded, width, height, type, quality);
      }
      if (blob.size <= ANNOUNCEMENT_IMAGE_MAX_BYTES) return { blob, type, width, height };
    }

    throw new Error('That image is still over 5 MB after resizing. Try a simpler picture.');
  } finally {
    pipeline.release?.(decoded);
  }
}

export interface UploadDeps {
  pipeline: ImagePipeline;
  /** `POST /admin/announcements/uploads`. */
  sign: (body: { contentType: string; size: number }) => Promise<AnnouncementImageUpload>;
  /** The PUT to storage. Not `apiFetch`: it is not our API and carries no token. */
  put: (url: string, blob: Blob, contentType: string) => Promise<{ ok: boolean }>;
}

/** Check, resize, sign, upload — and hand back what the editor inserts. */
export async function uploadAnnouncementImage(
  file: File,
  deps: UploadDeps,
): Promise<UploadedImage> {
  const problem = imageFileProblem(file);
  if (problem !== null) throw new Error(problem);

  const prepared = await prepareImage(file, deps.pipeline);
  const signed = await deps.sign({ contentType: prepared.type, size: prepared.blob.size });

  const response = await deps.put(signed.uploadUrl, prepared.blob, prepared.type);
  if (!response.ok) {
    throw new Error('The image did not upload. Check your connection and try again.');
  }
  return { src: signed.publicUrl, width: prepared.width, height: prepared.height };
}

/** Straight to Supabase Storage, as `gcashApi.uploadProof` does. */
export function putToStorage(
  url: string,
  blob: Blob,
  contentType: string,
): Promise<{ ok: boolean }> {
  return fetch(url, { method: 'PUT', headers: { 'content-type': contentType }, body: blob });
}

/**
 * The real pipeline: `createImageBitmap` (which applies EXIF orientation, so
 * a portrait phone photo stays upright) and a canvas.
 */
export const browserPipeline: ImagePipeline = {
  async decode(file) {
    const bitmap = await createImageBitmap(file);
    return { width: bitmap.width, height: bitmap.height, source: bitmap };
  },

  encode(image, width, height, type, quality) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (context === null) return Promise.reject(new Error('This browser cannot resize images.'));

    // JPEG has no transparency: without a fill, a transparent PNG turns black.
    if (type === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(image.source as CanvasImageSource, 0, 0, width, height);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) =>
          blob === null ? reject(new Error('Could not encode the image.')) : resolve(blob),
        type,
        quality,
      );
    });
  },

  release(image) {
    (image.source as ImageBitmap | undefined)?.close?.();
  },
};
