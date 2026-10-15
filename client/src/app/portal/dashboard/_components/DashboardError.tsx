import { EmptyState } from '@/components/portal/ui';

/**
 * The page-level failure: `/me/overview` did not answer, so there is no name
 * and no plan to show. The sections' own failures never reach here — each of
 * those offers its own "Try again" in place.
 */
export function DashboardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="p-card">
      <EmptyState
        title="Couldn't load your dashboard"
        hint="Check your connection, then try again."
        action={
          <button type="button" className="p-btn p-btn-gold p-btn-sm" onClick={onRetry}>
            Try again
          </button>
        }
      />
    </div>
  );
}
