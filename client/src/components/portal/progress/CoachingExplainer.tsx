'use client';

import Link from 'next/link';
import { Card } from '@/components/portal/ui';

/**
 * What a member WITHOUT a coach sees at the top of My Progress.
 *
 * Owner decision: progress is recorded by the member's assigned coach, so a
 * member with none has nobody recording for them. The page stays — anything
 * they recorded themselves before the change is still theirs to read — and
 * this card says plainly why there is nothing new and what to do about it,
 * rather than leaving an empty chart to look like a broken screen.
 *
 * Legacy markup only: this folder is not Tailwind-scanned.
 */
export function CoachingExplainer({ hasHistory }: { hasHistory: boolean }) {
  return (
    <Card>
      <div style={{ display: 'grid', gap: 10 }}>
        {/* A heading, not the small-caps card label: this sentence is the
            whole message of the card, not a caption for something below. */}
        <h2
          style={{
            margin: 0,
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 17,
            lineHeight: 1.3,
            color: 'var(--p-ink)',
          }}
        >
          Progress tracking comes with personal coaching
        </h2>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
          Your coach weighs and measures you at your sessions and sets goals with you, and every
          reading they take shows up here. You don&rsquo;t have a coach yet — ask at the front desk
          and they can set you up with one.
        </p>
        {hasHistory ? (
          <p style={{ margin: 0, fontSize: 13, color: 'var(--p-ink3)' }}>
            The entries below are ones you recorded yourself before coaches took this over. They
            stay yours to look back on.
          </p>
        ) : null}
        <div>
          <Link href="/portal/coach" className="p-btn p-btn-ghost p-btn-sm">
            About coaching
          </Link>
        </div>
      </div>
    </Card>
  );
}
