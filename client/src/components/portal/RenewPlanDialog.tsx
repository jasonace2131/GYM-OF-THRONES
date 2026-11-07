'use client';

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
import { formatCentavos } from '@/lib/portalData';

/**
 * "Renew" on My Subscription asks first, then opens Pay / GCash with the plan
 * already chosen (owner, 2026-11-07).
 *
 * The button it replaces read "Renew at the front desk" and had no action at
 * all, so a member with a cancelled or expired plan tapped it and nothing
 * happened. A renewal still needs the desk to confirm the payment, so this
 * says so rather than implying the tap renews anything by itself.
 *
 * Styled through the shared dialog primitives only: this folder is not
 * Tailwind-scanned, so no utility class is written here.
 */
export function RenewPlanDialog({
  open,
  plan,
  onPay,
  onClose,
}: {
  open: boolean;
  /** The plan being renewed; null when the member has none and is choosing one. */
  plan: { name: string; priceCentavos: number; termMonths: number } | null;
  onPay: () => void;
  onClose: () => void;
}) {
  const term =
    plan === null ? '' : plan.termMonths === 1 ? '1 month' : `${plan.termMonths} months`;

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          {/* The heading face, as the portal's other dialogs have it (they use a
              Tailwind class this unscanned folder cannot). */}
          <AlertDialogTitle style={{ fontFamily: 'var(--font-heading)' }}>
            {plan === null ? 'Choose a plan' : `Renew ${plan.name}?`}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {plan === null
              ? 'Pay for a plan by GCash now and the front desk confirms it, or pay at the front desk.'
              : `${formatCentavos(plan.priceCentavos)} for ${term}. Pay by GCash now and the front desk confirms it, or pay at the front desk.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Not now</AlertDialogCancel>
          <AlertDialogAction onClick={onPay}>Pay with GCash</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
