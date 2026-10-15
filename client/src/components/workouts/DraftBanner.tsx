import Link from 'next/link';
import type { WorkoutDraftView } from '@got/shared';
import { IconSparkle, IconWarning } from './icons';
import { Notice, buttonClass } from './ui';

/** The hub's strip when a draft exists: still being written, ready, or failed. */
export function DraftBanner({ draft }: { draft: WorkoutDraftView }) {
  const tone = draft.status === 'FAILED' ? 'warn' : 'info';
  const text =
    draft.status === 'RUNNING'
      ? 'Your draft is being written.'
      : draft.status === 'READY'
        ? 'Your draft is ready — save it or it stays a draft.'
        : (draft.error ?? 'Your last draft did not finish.');
  return (
    <Notice
      tone={tone}
      icon={draft.status === 'FAILED' ? <IconWarning /> : <IconSparkle />}
      className="items-center"
    >
      <span className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{text}</span>
        <Link
          href={
            draft.status === 'FAILED' ? '/portal/workouts/new?from=draft' : '/portal/workouts/draft'
          }
          className={buttonClass('dark', 'xs')}
        >
          {draft.status === 'FAILED' ? 'Try again' : 'Continue'}
        </Link>
      </span>
    </Notice>
  );
}
