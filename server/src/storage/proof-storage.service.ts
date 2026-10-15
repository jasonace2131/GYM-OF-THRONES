import { HttpStatus, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';

/**
 * What the browser needs to put an image into the bucket without the bytes
 * ever passing through this API.
 */
export interface SignedUpload {
  /** The object path the caller must hand back when they submit the form. */
  path: string;
  /** One-shot URL the browser PUTs the file to. */
  uploadUrl: string;
  /** Supabase's own token for the upload, required by its JS client. */
  token: string;
}

/** How long a view link lives. Long enough to render, short enough to be useless if copied. */
const VIEW_URL_TTL_SECONDS = 120;

/** A phone screenshot is a few hundred KB. Five MB is a generous typo guard. */
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

/** What a GCash screenshot can actually be. No PDFs, no HEIC surprises. */
export const ALLOWED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/**
 * The GCash proof bucket.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHY THERE IS A BUCKET AT ALL, given the Payment model says there is not.
 *
 * That comment was written about a WALLET CAPTURE — a screenshot of the
 * member's own GCash home or transaction history, carrying their balance,
 * their name and unrelated payments. RA 10173 proportionality rules that out,
 * and it still does.
 *
 * A GCash SEND CONFIRMATION is a different image. It carries the amount, the
 * timestamp, the reference, and the RECIPIENT's name and number — which is the
 * gym's own account, not the member's. The sender's name and number are not on
 * it. So the proportionality objection does not reach this image, and what is
 * left is an ordinary business record of a payment the gym received.
 *
 * WHAT IT IS FOR, AND WHAT IT IS NOT. It is a paper trail: back-tracking a
 * disputed payment months later, and giving staff something to look at when a
 * member submits a payment remotely rather than standing at the counter. It is
 * NOT verification. A reference that is not in the gym's own Transactions tab
 * is not a payment no matter how good the picture looks, which is exactly why
 * the named staff attestation still exists and is still the thing that counts.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * PRIVATE BUCKET, ALWAYS. Every read is a short-lived signed URL minted here,
 * so an object path appearing in a log or a URL bar is not the same thing as
 * the image leaking. Uploads are signed one-shot URLs for the same reason and
 * one more: a few hundred KB per sale has no business travelling through a
 * Nest request pipeline that exists to validate DTOs.
 *
 * Warn-and-disable when `SUPABASE_SERVICE_KEY` is unset, matching
 * `SupabaseAdminService` exactly. The gym must still boot, still take money and
 * still sell memberships with storage unconfigured — attaching an image is the
 * only thing that stops working.
 */
@Injectable()
export class ProofStorageService implements OnModuleInit {
  private readonly logger = new Logger(ProofStorageService.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket: string;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('SUPABASE_URL', { infer: true });
    const key = config.get('SUPABASE_SERVICE_KEY', { infer: true });
    this.bucket = config.get('GCASH_PROOF_BUCKET', { infer: true });

    this.client =
      key === undefined
        ? null
        : createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    if (this.client === null) {
      this.logger.warn('SUPABASE_SERVICE_KEY unset — GCash proof images are disabled');
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Create the bucket if it is not there, once, at boot.
   *
   * Idempotent and non-fatal: a gym whose storage is misconfigured must still
   * open in the morning. `createBucket` returns a duplicate error on every
   * boot after the first, which is the expected path and is not logged as a
   * failure.
   *
   * `public: false` is the load-bearing argument. A public bucket would make
   * every object readable to anyone who learns its path, which for payment
   * records is the whole risk in one flag.
   */
  async onModuleInit(): Promise<void> {
    if (this.client === null) return;

    const { error } = await this.client.storage.createBucket(this.bucket, {
      public: false,
      fileSizeLimit: MAX_PROOF_BYTES,
      allowedMimeTypes: [...ALLOWED_PROOF_TYPES],
    });

    if (error === null) {
      this.logger.log(`created private storage bucket "${this.bucket}"`);
      return;
    }

    // Already there on every boot after the first. Supabase reports this as a
    // 409 / "already exists" rather than a success, so it is matched by shape
    // rather than treated as an outage.
    if (/exist/i.test(error.message)) return;

    this.logger.warn(`could not ensure bucket "${this.bucket}": ${error.message}`);
  }

  /**
   * Mint a one-shot upload URL.
   *
   * The PATH IS MINTED HERE, never accepted from the caller. A client-supplied
   * path is a directory traversal and an overwrite of somebody else's object
   * waiting to happen; a random uuid under a caller-scoped prefix is neither.
   */
  async signUpload(prefix: string, contentType: string): Promise<SignedUpload> {
    const client = this.require();

    if (!ALLOWED_PROOF_TYPES.includes(contentType as (typeof ALLOWED_PROOF_TYPES)[number])) {
      throw new DomainException(
        'PROOF_TYPE_UNSUPPORTED',
        'Attach a JPEG, PNG or WebP image.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const extension =
      contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const path = `${prefix}/${randomUUID()}.${extension}`;

    const { data, error } = await client.storage.from(this.bucket).createSignedUploadUrl(path);
    if (error !== null || data === null) {
      this.logger.error(`could not sign upload for ${path}: ${error?.message ?? 'no data'}`);
      throw new DomainException(
        'PROOF_UPLOAD_UNAVAILABLE',
        'Could not prepare the image upload. Record the reference and try the image again later.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    return { path, uploadUrl: data.signedUrl, token: data.token };
  }

  /**
   * A short-lived link to view one object.
   *
   * Returns NULL rather than throwing when the object is missing. A payment
   * whose image was never uploaded, or was cleaned up, must still render its
   * row — a screen that 500s because a picture is absent is worse than one
   * that says there is no picture.
   */
  async signView(path: string): Promise<string | null> {
    if (this.client === null) return null;

    const { data, error } = await this.client.storage
      .from(this.bucket)
      .createSignedUrl(path, VIEW_URL_TTL_SECONDS);

    if (error !== null || data === null) {
      this.logger.warn(`could not sign view for ${path}: ${error?.message ?? 'no data'}`);
      return null;
    }
    return data.signedUrl;
  }

  /**
   * Remove one object. Best-effort and never thrown.
   *
   * Only ever called when the record that owns the image is itself going away,
   * and a failure here must not block that. An orphaned object costs pennies;
   * a blocked void costs the counter.
   */
  async remove(path: string): Promise<void> {
    if (this.client === null) return;
    const { error } = await this.client.storage.from(this.bucket).remove([path]);
    if (error !== null) this.logger.warn(`could not remove ${path}: ${error.message}`);
  }

  private require(): SupabaseClient {
    if (this.client === null) {
      throw new DomainException(
        'PROOF_UPLOAD_DISABLED',
        'Image attachments are not configured on this server.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.client;
  }
}
