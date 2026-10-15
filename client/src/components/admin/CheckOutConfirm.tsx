'use client';

import { adminApi } from '@/lib/adminApi';
import { ConfirmActionModal } from './actions/ConfirmActionModal';

/** The two fields a check-out needs from any visit row the console shows. */
export interface OpenVisit {
  checkInId: string;
  member: { firstName: string; lastName: string };
}

/**
 * "Check out" — leaving the gym, never paying. Shared by "In the gym now" on
 * /admin/attendance and the register on /admin/walk-ins, so a member and an
 * account-less walk-in guest are checked out the same way, through the same
 * `POST /front-desk/check-ins/:id/checkout` (gated on `checkin.close`).
 *
 * The route is a conditional update: if somebody else checked the visit out
 * first, the server says so and the message shows inside this dialog rather
 * than vanishing into an unhandled promise, which is what the old
 * `void adminApi.checkOut(…).then(…)` did.
 */
export function CheckOutConfirm({
  visit,
  onClose,
  onDone,
}: {
  /** `null` while closed. */
  visit: OpenVisit | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const name =
    visit === null ? '' : `${visit.member.firstName} ${visit.member.lastName}`.trim();

  return (
    <ConfirmActionModal
      open={visit !== null}
      title={`Check out ${name}?`}
      subtitle={`Ends ${name}'s visit now. They leave "In the gym now" and the length of the visit is recorded.`}
      confirmLabel="Check out"
      cancelLabel="Keep them in"
      onConfirm={async () => {
        if (visit === null) return;
        await adminApi.checkOut(visit.checkInId);
      }}
      onClose={onClose}
      onDone={onDone}
    />
  );
}
