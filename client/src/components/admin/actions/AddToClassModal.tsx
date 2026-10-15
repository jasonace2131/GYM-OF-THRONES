'use client';

import { useState } from 'react';
import type { ClassSessionWire } from '@got/shared';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { classTime } from '@/lib/classes';
import {
  staffAddCheck,
  staffAddOutcome,
  stillWaiting,
  type StaffAddConcern,
  type StaffAddOutcome,
} from '@/lib/classRegister';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { waitlistClosesTime } from '@/lib/schedule/cancelCopy';
import { shortDay } from '@/lib/schedule/labels';
import { Modal } from '../Modal';
import { MemberPicker } from '../MemberPicker';
import { ConfirmDialog, useConfirmAction } from './ConfirmDialog';

/**
 * The desk putting a member into a class by hand — a phone booking, a member
 * whose app is not working, a walk-in joining a class that is running.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT A DESK ADD SKIPS, AND WHAT IT NEVER DOES (owner, 2026-10-11).
 *
 * It skips the two rules a member books under: the plan must cover the class
 * day, and the class must be inside their booking window. The person at the
 * counter can know what the system does not — a renewal being paid right
 * now — so the plan check here WARNS and leaves the decision with them. The
 * door still checks the plan on the day.
 *
 * It never overbooks. A free place books them in; a full class puts them on
 * the waitlist while it is open; after that the add is refused and the places
 * have to be raised first. The preview below says which, and the server
 * decides again under a lock on the class.
 *
 * A waitlist place the desk gave moves up like any other, in queue order, and
 * the plan is not checked again when their turn comes: the desk's add already
 * waived it. So "they move in by themselves" below is a promise the server
 * keeps — until the waitlist closes, as for everybody.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Two steps, like ManualCheckInModal: the picker lives in a Modal (a
 * ConfirmDialog carries facts, never a form), and the add is confirmed with a
 * second click that names the member and the class.
 */
export function AddToClassModal({
  open,
  session,
  now,
  onClose,
  onAdded,
}: {
  open: boolean;
  /**
   * The class, with its counts taken from the register the desk is looking at
   * (`withRegisterCounts`) — fresher than the timetable row.
   */
  session: ClassSessionWire;
  /** The register's ticking clock — the preview changes when the waitlist closes. */
  now: Date;
  onClose: () => void;
  /** After the add lands: reload the register and the timetable's counts. */
  onAdded: () => void;
}) {
  const [member, setMember] = useState<MemberListItem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run, reset } = useConfirmAction();

  const outcome = staffAddOutcome(session, now);
  const check =
    member === null
      ? null
      : staffAddCheck(member, session.businessDate, gymToday(now, GYM_TIMEZONE));
  const takesSomebody = outcome === 'SEAT' || outcome === 'WAITLIST';
  const ready = member !== null && takesSomebody && check?.blocks !== true;
  const place = session.waitlistCount + 1;

  const close = (): void => {
    if (busy) return;
    setMember(null);
    setConfirming(false);
    reset();
    onClose();
  };

  const add = (): void => {
    if (member === null) return;
    void run(() => adminApi.addToClass(session.id, member.userId)).then((ok) => {
      if (!ok) return;
      setMember(null);
      setConfirming(false);
      reset();
      onAdded();
      onClose();
    });
  };

  // Waiting counts only while the queue can still move, as on the timetable.
  const waiting = stillWaiting(session, now);
  const counts = `${session.bookedCount} of ${session.capacity} booked${
    waiting > 0 ? ` · ${waiting} waiting` : ''
  }`;
  // "4:00 PM", or "4:00 PM tomorrow" for a class booked days ahead.
  const closesAt = waitlistClosesTime(session.startsAt, now);

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title={`Add a member to “${session.title}”`}
        subtitle={`${shortDay(session.businessDate)} at ${classTime(session.startsAt)} · ${counts}`}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={!ready}
            >
              {outcome === 'WAITLIST' ? 'Add to the waitlist' : 'Add to the class'}
            </button>
          </>
        }
      >
        <MemberPicker
          value={member}
          onSelect={(next) => {
            setMember(next);
            reset();
          }}
          autoFocus
        />

        {check === null ? null : (
          <div className="a-verdict" data-tone={check.blocks ? 'danger' : 'warn'} role="status">
            <div className="a-verdict-head">{CONCERN_HEAD[check.concern]}</div>
            <p className="a-verdict-sub">{check.message}</p>
            {check.blocks ? null : (
              <p className="a-verdict-next">
                You can still add them — the desk books by hand — but the door decides on the day.
              </p>
            )}
          </div>
        )}

        <p className="a-confirm-text">{outcomeSentence(outcome, place, closesAt)}</p>
      </Modal>

      <ConfirmDialog
        open={open && confirming && member !== null}
        title={
          member === null ? '' : `Add ${member.firstName} ${member.lastName} to “${session.title}”?`
        }
        consequence={
          member === null
            ? ''
            : outcome === 'WAITLIST'
              ? `${member.firstName} joins the waitlist at #${place} in your name, and gets a notice in the app. If a place opens up before ${closesAt}, they move in by themselves.`
              : `${member.firstName} is booked into the class in your name, and gets a notice in the app.`
        }
        confirmLabel={outcome === 'WAITLIST' ? 'Add to the waitlist' : 'Book them in'}
        cancelLabel="Back"
        busy={busy}
        error={error}
        onConfirm={add}
        onClose={() => {
          if (busy) return;
          reset();
          setConfirming(false);
        }}
      >
        {/* The warning travels to the second click: it is the moment that counts. */}
        {check === null ? null : (
          <ul className="a-confirm-facts">
            <li>{check.message}</li>
          </ul>
        )}
      </ConfirmDialog>
    </>
  );
}

const CONCERN_HEAD: Record<StaffAddConcern, string> = {
  NOT_A_MEMBER: 'Not a member account',
  ACCOUNT: 'The door will refuse them',
  PLAN: 'Their plan will not cover this class',
};

/**
 * What the add will do, said before anybody is picked as well as after.
 * `closesAt` is when the waitlist closes, on the gym's clock ("4:00 PM tomorrow").
 */
function outcomeSentence(outcome: StaffAddOutcome, place: number, closesAt: string): string {
  switch (outcome) {
    case 'SEAT':
      return 'A place is free, so they are booked straight in.';
    case 'WAITLIST':
      return `The class is full, so they join the waitlist at #${place}. If a place opens up before ${closesAt}, they move in by themselves.`;
    case 'WAITLIST_CLOSED':
      return 'The class is full and its waitlist has closed. Raise the places first, then add them.';
    case 'FINISHED':
      return 'This class has finished, so nobody can be added to it.';
    case 'CANCELLED':
      return 'This class was cancelled, so nobody can be added to it.';
  }
}
