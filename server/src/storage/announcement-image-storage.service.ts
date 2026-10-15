import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  ANNOUNCEMENT_IMAGE_BUCKET,
  ANNOUNCEMENT_IMAGE_MAX_BYTES,
  ANNOUNCEMENT_IMAGE_PREFIX,
  ANNOUNCEMENT_IMAGE_TYPES,
  announcementImageBaseUrl,
  type AnnouncementImageUpload,
} from '@got/shared';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';

/** One object in the bucket, as the cleanup job needs to see it. */
export interface StoredAnnouncementImage {
  /** Full key inside the bucket: `announcements/<uuid>.<ext>`. */
  key: string;
  createdAt: Date;
}

/** Supabase's `list` page size ceiling. */
const LIST_PAGE = 1000;
/** Keys per `remove` call — small enough that one bad batch loses little. */
const REMOVE_BATCH = 100;

const BUCKET_SETTINGS = {
  public: true,
  fileSizeLimit: ANNOUNCEMENT_IMAGE_MAX_BYTES,
  allowedMimeTypes: [...ANNOUNCEMENT_IMAGE_TYPES],
};

/**
 * The announcements image bucket — a SIBLING of `ProofStorageService`, not a
 * generalisation of it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PUBLIC, WHERE THE GCASH BUCKET IS PRIVATE, AND BOTH ARE RIGHT.
 *
 * A GCash receipt is a payment record: every read is a short-lived signed URL,
 * so a leaked path is not a leaked image. An announcement image is the
 * opposite — it is shown to every member on every dashboard load, cached by
 * their browsers, and says nothing the notice itself does not. Signing a view
 * URL per image per member would be a request per image per page for no
 * privacy gained. Sharing one class between the two would mean one of them
 * carries a `public` flag that is the whole risk of the other in one boolean.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * What stays the same as the GCash bucket: the object PATH is minted here and
 * never accepted from a caller; uploads are one-shot signed URLs the browser
 * PUTs to directly, so the bytes never pass through a Nest worker; and the
 * whole thing warn-and-disables without `SUPABASE_SERVICE_KEY` — the gym still
 * boots and staff can still post text, only the image buttons disappear.
 *
 * `publicBaseUrl` is known even when disabled: it comes from `SUPABASE_URL`
 * alone, and the rich-content validator needs it to keep accepting notices
 * that already carry images.
 */
@Injectable()
export class AnnouncementImageStorageService implements OnModuleInit {
  private readonly logger = new Logger(AnnouncementImageStorageService.name);
  private readonly client: SupabaseClient | null;

  /** `<SUPABASE_URL>/storage/v1/object/public/announcements/` */
  readonly publicBaseUrl: string;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('SUPABASE_URL', { infer: true });
    const key = config.get('SUPABASE_SERVICE_KEY', { infer: true });
    this.publicBaseUrl = announcementImageBaseUrl(url);

    this.client =
      key === undefined
        ? null
        : createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    if (this.client === null) {
      this.logger.warn('SUPABASE_SERVICE_KEY unset — announcement images are disabled');
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Ensure the bucket exists, public, with the type and size limits — once, at
   * boot, and never fatally.
   *
   * Unlike the GCash bucket, an existing bucket is CONVERGED to these settings
   * rather than left alone: one created by hand as private would 400 every
   * image on every dashboard, silently, and the settings here are the spec.
   */
  async onModuleInit(): Promise<void> {
    if (this.client === null) return;

    try {
      const { error } = await this.client.storage.createBucket(
        ANNOUNCEMENT_IMAGE_BUCKET,
        BUCKET_SETTINGS,
      );
      if (error === null) {
        this.logger.log(`created public storage bucket "${ANNOUNCEMENT_IMAGE_BUCKET}"`);
        return;
      }
      if (!/exist/i.test(error.message)) {
        this.logger.warn(
          `could not ensure bucket "${ANNOUNCEMENT_IMAGE_BUCKET}": ${error.message}`,
        );
        return;
      }

      const updated = await this.client.storage.updateBucket(
        ANNOUNCEMENT_IMAGE_BUCKET,
        BUCKET_SETTINGS,
      );
      if (updated.error !== null) {
        this.logger.warn(
          `could not update bucket "${ANNOUNCEMENT_IMAGE_BUCKET}": ${updated.error.message}`,
        );
      }
    } catch (caught) {
      this.logger.warn(
        `could not ensure bucket "${ANNOUNCEMENT_IMAGE_BUCKET}": ${
          caught instanceof Error ? caught.message : String(caught)
        }`,
      );
    }
  }

  /**
   * A one-shot upload URL for one image.
   *
   * The type and size are re-checked here as well as in the DTO: this is the
   * last code that runs before storage, and the bucket's own limits are the
   * third line, not the first.
   */
  async signUpload(contentType: string, size: number): Promise<AnnouncementImageUpload> {
    const client = this.require();

    if (!(ANNOUNCEMENT_IMAGE_TYPES as readonly string[]).includes(contentType)) {
      throw new DomainException(
        'ANNOUNCEMENT_CONTENT_INVALID',
        'Attach a JPEG, PNG or WebP image.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!Number.isInteger(size) || size < 1 || size > ANNOUNCEMENT_IMAGE_MAX_BYTES) {
      throw new DomainException(
        'ANNOUNCEMENT_CONTENT_INVALID',
        'That image is over 5 MB.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const extension =
      contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${ANNOUNCEMENT_IMAGE_PREFIX}/${randomUUID()}.${extension}`;

    const { data, error } = await client.storage
      .from(ANNOUNCEMENT_IMAGE_BUCKET)
      .createSignedUploadUrl(path);
    if (error !== null || data === null) {
      this.logger.error(`could not sign upload for ${path}: ${error?.message ?? 'no data'}`);
      throw new DomainException(
        'ANNOUNCEMENT_UPLOAD_UNAVAILABLE',
        'Could not prepare the image upload. Try again in a moment.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return {
      path,
      uploadUrl: data.signedUrl,
      token: data.token,
      publicUrl: `${this.publicBaseUrl}${path}`,
    };
  }

  /**
   * Every object under the prefix, oldest first.
   *
   * THROWS on a storage error rather than returning []: the cleanup job reads
   * an empty list as "nothing to delete", which is harmless, but a caller that
   * wanted the list for anything else must not mistake an outage for an empty
   * bucket.
   */
  async listObjects(): Promise<StoredAnnouncementImage[]> {
    if (this.client === null) return [];
    const bucket = this.client.storage.from(ANNOUNCEMENT_IMAGE_BUCKET);

    const objects: StoredAnnouncementImage[] = [];
    for (let offset = 0; ; offset += LIST_PAGE) {
      const { data, error } = await bucket.list(ANNOUNCEMENT_IMAGE_PREFIX, {
        limit: LIST_PAGE,
        offset,
        sortBy: { column: 'created_at', order: 'asc' },
      });
      if (error !== null || data === null) {
        throw new Error(
          `could not list "${ANNOUNCEMENT_IMAGE_BUCKET}": ${error?.message ?? 'no data'}`,
        );
      }

      for (const item of data) {
        // A folder has no id and no created_at; nothing is minted into one.
        if (item.id === null || item.created_at === null) continue;
        objects.push({
          key: `${ANNOUNCEMENT_IMAGE_PREFIX}/${item.name}`,
          createdAt: new Date(item.created_at),
        });
      }
      if (data.length < LIST_PAGE) return objects;
    }
  }

  /**
   * Remove objects, best-effort, in small batches. Returns how many went.
   * A failed batch is logged and skipped: the next nightly run retries it.
   */
  async remove(keys: readonly string[]): Promise<number> {
    if (this.client === null || keys.length === 0) return 0;
    const bucket = this.client.storage.from(ANNOUNCEMENT_IMAGE_BUCKET);

    let removed = 0;
    for (let i = 0; i < keys.length; i += REMOVE_BATCH) {
      const batch = keys.slice(i, i + REMOVE_BATCH);
      const { error } = await bucket.remove(batch);
      if (error !== null) {
        this.logger.warn(`could not remove ${batch.length} image(s): ${error.message}`);
        continue;
      }
      removed += batch.length;
    }
    return removed;
  }

  private require(): SupabaseClient {
    if (this.client === null) {
      throw new DomainException(
        'ANNOUNCEMENT_UPLOAD_DISABLED',
        'Image uploads are not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.client;
  }
}
