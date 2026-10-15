import { apiFetch } from './api';

/**
 * The member's own GCash claim — "I sent you the money, here is the receipt."
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NONE OF THIS PAYS FOR ANYTHING, and the naming keeps saying so.
 *
 * Owner decision #9: every peso lands in a counted till against an open shift,
 * entered by a person who saw it. A member submits a CLAIM; staff check the
 * gym's own GCash Transactions tab and record the sale themselves. So there is
 * no `pay()` in this file and there must never be one.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type GcashSubmissionStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface MyGcashSubmission {
  id: string;
  status: GcashSubmissionStatus;
  planCode: string;
  amountCentavos: number;
  reference: string;
  submittedAt: string;
  reviewedAt: string | null;
  rejectReason: string | null;
  /** Short-lived signed link. Expect it to be null when storage is off. */
  proofUrl: string | null;
}

export interface GcashSubmissionForReview extends MyGcashSubmission {
  member: { userId: string; firstName: string; lastName: string; memberCode: string | null };
  planPriceCentavos: number | null;
  planName: string | null;
}

interface SignedUpload {
  path: string;
  uploadUrl: string;
  token: string;
}

/** What a phone camera or screenshot actually produces. Mirrors the server. */
export const ALLOWED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_PROOF_BYTES = 5 * 1024 * 1024;

export const gcashApi = {
  /**
   * Upload the screenshot straight to storage, and hand back the object path.
   *
   * TWO STEPS, AND THE IMAGE NEVER TOUCHES OUR API. The server mints a
   * one-shot signed URL, the browser PUTs the file to Supabase directly, and
   * only the resulting path travels through our request pipeline. A few
   * hundred KB has no business going through a Nest worker built to validate
   * DTOs, and on gym wifi a slow upload would hold that worker open.
   *
   * The path is minted server-side from the caller's own id, so it is not a
   * value this function could tamper with even if it wanted to.
   */
  uploadProof: async (file: File): Promise<string> => {
    if (!ALLOWED_PROOF_TYPES.includes(file.type)) {
      throw new Error('Attach a JPEG, PNG or WebP image.');
    }
    if (file.size > MAX_PROOF_BYTES) {
      throw new Error('That image is over 5MB. A screenshot is usually well under 1MB.');
    }

    const signed = await apiFetch<SignedUpload>('/me/gcash/upload-url', {
      method: 'POST',
      body: JSON.stringify({ contentType: file.type }),
    });

    // Straight to Supabase Storage. Deliberately a bare fetch and NOT
    // `apiFetch`: this is not our API, it carries no bearer token, and it
    // returns no `{ success, data }` envelope.
    const response = await fetch(signed.uploadUrl, {
      method: 'PUT',
      headers: { 'content-type': file.type },
      body: file,
    });

    if (!response.ok) {
      throw new Error('The image did not upload. Check your connection and try again.');
    }
    return signed.path;
  },

  submit: (body: {
    planCode: string;
    amountCentavos: number;
    reference: string;
    proofPath: string;
  }): Promise<MyGcashSubmission> =>
    apiFetch<MyGcashSubmission>('/me/gcash/submissions', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  mine: (): Promise<MyGcashSubmission[]> => apiFetch<MyGcashSubmission[]>('/me/gcash/submissions'),

  /** Staff. `payment.read`. */
  queue: (status: GcashSubmissionStatus = 'PENDING'): Promise<GcashSubmissionForReview[]> =>
    apiFetch<GcashSubmissionForReview[]>(`/admin/gcash-submissions?status=${status}`),

  /**
   * Staff. `payment.record`. Links the claim to the payment already recorded
   * for its reference — it does NOT create the payment. Fails with
   * `GCASH_PAYMENT_NOT_RECORDED` when staff have not recorded it yet, which is
   * the correct order and the message says so.
   */
  approve: (id: string): Promise<MyGcashSubmission> =>
    apiFetch<MyGcashSubmission>(`/admin/gcash-submissions/${id}/approve`, { method: 'POST' }),

  /** Staff. The reason is shown to the MEMBER. */
  reject: (id: string, reason: string): Promise<MyGcashSubmission> =>
    apiFetch<MyGcashSubmission>(`/admin/gcash-submissions/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
