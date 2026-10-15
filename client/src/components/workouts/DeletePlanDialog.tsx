'use client';

import { useState } from 'react';
import type { MemberWorkoutPlanView } from '@got/shared';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { workoutsApi } from '@/lib/workouts/api';
import { workoutErrorMessage } from '@/lib/workouts/errors';

/**
 * "Delete this plan?" — the one irreversible thing a member can do to a plan
 * (owner, 2026-10-06: a way to clear plans out before the library floods).
 *
 * Confirmed, because there is no undo: the server hard-deletes the plan. What
 * it does NOT take with it is said plainly — logged workouts keep their own
 * copy of the plan's name and exercises (the session's link is set null), so
 * history and streaks survive.
 *
 * The dialog stays open while the request runs and shows the server's reason
 * if it fails, rather than closing on an error the member never sees.
 */
export function DeletePlanDialog({
  plan,
  hasCoachPlan = false,
  onClose,
  onDeleted,
}: {
  /** The plan to delete; null closes the dialog. */
  plan: Pick<MemberWorkoutPlanView, 'id' | 'name' | 'isActive'> | null;
  /**
   * Whether the member's coach has saved a plan for them. With no AI plan
   * active, the coach's plan is what Today follows — so deleting the active
   * AI plan hands Today to it rather than leaving it empty.
   */
  hasCoachPlan?: boolean;
  onClose: () => void;
  onDeleted: (planId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confirm = (): void => {
    if (plan === null) return;
    setBusy(true);
    setError(null);
    workoutsApi
      .deletePlan(plan.id)
      .then(() => {
        onDeleted(plan.id);
        onClose();
      })
      .catch((caught: unknown) => setError(workoutErrorMessage(caught)))
      .finally(() => setBusy(false));
  };

  return (
    <AlertDialog
      open={plan !== null}
      onOpenChange={(open) => {
        if (!open && !busy) {
          setError(null);
          onClose();
        }
      }}
    >
      <AlertDialogContent>
        {plan === null ? null : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle className="font-display">Delete {plan.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                {plan.isActive
                  ? hasCoachPlan
                    ? "This is your active plan, so Today switches to your coach's plan. "
                    : 'This is your active plan, so Today will have no plan to follow until you pick another. '
                  : ''}
                The plan and its weekly schedule are removed for good. Workouts you already logged
                stay in your history.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {error === null ? null : (
              <p role="alert" className="m-0 text-[13px] text-danger">
                {error}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Keep plan</AlertDialogCancel>
              <AlertDialogAction
                disabled={busy}
                variant="destructive"
                onClick={(event) => {
                  // Stay open until the request settles.
                  event.preventDefault();
                  confirm();
                }}
              >
                {busy ? 'Deleting…' : 'Delete plan'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
