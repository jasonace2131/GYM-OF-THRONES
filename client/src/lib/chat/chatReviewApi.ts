import type { PaginatedData } from '@got/shared';
import { apiFetch } from '../api';

/**
 * Complaint review of coach-member conversations — `chat.review`, ADMIN at
 * ALL (feat/coach-tools). Its own module rather than a block in adminApi.ts,
 * so the console's biggest file is not one more merge away from conflicting.
 *
 * Listing names who talked to whom and when — no text. Reading a conversation
 * is a POST that carries a reason, and every read is written to the audit log.
 */

export interface ReviewThreadRow {
  id: string;
  coach: { id: string; firstName: string; lastName: string };
  member: { id: string; firstName: string; lastName: string };
  messageCount: number;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface ReviewMessage {
  id: string;
  senderId: string;
  /** Always present here — a withdrawn message keeps its text for review. */
  body: string;
  createdAt: string;
  deletedAt: string | null;
}

export interface ThreadReview {
  thread: ReviewThreadRow;
  messages: ReviewMessage[];
}

export const chatReviewApi = {
  threads: (
    params: { page?: number; limit?: number } = {},
  ): Promise<PaginatedData<ReviewThreadRow>> => {
    const search = new URLSearchParams();
    if (params.page !== undefined) search.set('page', String(params.page));
    if (params.limit !== undefined) search.set('limit', String(params.limit));
    const query = search.toString();
    return apiFetch<PaginatedData<ReviewThreadRow>>(
      `/admin/chat/threads${query === '' ? '' : `?${query}`}`,
    );
  },

  /** Audited (CHAT_THREAD_REVIEWED) with `reason`, every time it is called. */
  review: (threadId: string, reason: string): Promise<ThreadReview> =>
    apiFetch<ThreadReview>(`/admin/chat/threads/${encodeURIComponent(threadId)}/review`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
};
