'use client';

import Link from 'next/link';
import { PERMISSIONS } from '@got/shared';
import { Card, CardHead } from '@/components/portal/ui';
import { usePermission } from '@/components/rbac/MeProvider';

/**
 * The way into chat review from the Coaches screen (feat/coach-tools). Shown
 * only to a caller holding `chat.review` at ALL — the page behind it checks
 * again, and the server checks again after that.
 */
export function ChatReviewCard() {
  const allowed = usePermission(PERMISSIONS.CHAT_REVIEW, { scope: 'ALL' });
  if (!allowed) return null;
  return (
    <Card>
      <CardHead
        title="Coach chat"
        action={
          <Link href="/admin/coaches/chat-review" className="p-btn p-btn-ghost p-btn-sm">
            Review a conversation
          </Link>
        }
      />
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
        Coaches and the members they coach message each other in the portal. Read a conversation
        only to look into a complaint — every read is recorded in the audit log with your reason.
      </p>
    </Card>
  );
}
