'use client';

import { useId, useState } from 'react';
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
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { ClassSession } from '@/lib/classes';
import {
  CLASS_LIMITS,
  classFormProblem,
  draftFor,
  type ClassDraft,
} from '@/lib/schedule/coachClasses';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { shortDay } from '@/lib/schedule/labels';
import { blockIntJunk, wholeOrNaN } from '@/lib/numberInput';

const FIELD =
  'h-10 w-full min-w-0 rounded-md border border-[color:var(--p-border-2)] bg-card px-3 text-[14.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold';
const LABEL = 'flex min-w-0 flex-col gap-1.5 text-[12.5px] font-semibold text-ink-2';

/**
 * A coach schedules or edits one of their own classes (owner, 2026-10-23).
 *
 * The coach is the caller and is not a field: the server refuses a class for
 * anybody else (403 CLASS_NOT_YOURS). Everything else — a start in the past,
 * places below the bookings — is the admin's own rule, refused by the same
 * service and shown here in the server's words.
 */
export function CoachClassSheet({
  open,
  session,
  day,
  coachName,
  busy,
  error,
  onSave,
  onClose,
}: {
  open: boolean;
  /** Null to create a new class; a class of the caller's to edit it. */
  session: ClassSession | null;
  /** The day in view, a new class's default date. */
  day: string;
  coachName: string;
  busy: boolean;
  /** The server's sentence from the last failed save. */
  error: string | null;
  onSave: (draft: ClassDraft) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {open ? (
          <ClassForm
            key={session?.id ?? `new-${day}`}
            session={session}
            day={day}
            coachName={coachName}
            busy={busy}
            error={error}
            onSave={onSave}
            onClose={onClose}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ClassForm({
  session,
  day,
  coachName,
  busy,
  error,
  onSave,
  onClose,
}: {
  session: ClassSession | null;
  day: string;
  coachName: string;
  busy: boolean;
  error: string | null;
  onSave: (draft: ClassDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<ClassDraft>(() => draftFor(session, day));
  const [problem, setProblem] = useState<string | null>(null);
  const ids = useId();
  const set = (patch: Partial<ClassDraft>): void => setDraft((current) => ({ ...current, ...patch }));
  const shown = problem ?? error;

  return (
    <form
      className="flex min-h-full flex-col"
      onSubmit={(event) => {
        event.preventDefault();
        const found = classFormProblem(draft);
        setProblem(found);
        if (found === null) onSave(draft);
      }}
    >
      <SheetHeader>
        <SheetTitle className="font-display">
          {session === null ? 'New class' : `Edit ${session.title}`}
        </SheetTitle>
        <SheetDescription>
          {session === null
            ? 'Members can see and book it on the timetable straight away.'
            : 'Changing the time or the name sends everybody booked a notice in the app.'}
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-col gap-4 px-4">
        <label className={LABEL}>
          Class
          <input
            className={FIELD}
            value={draft.title}
            maxLength={CLASS_LIMITS.titleMax}
            placeholder="HIIT Conditioning"
            onChange={(e) => set({ title: e.target.value })}
            disabled={busy}
          />
        </label>

        <p className="m-0 text-[13px] text-ink-2">
          Coach: <span className="font-semibold text-foreground">{coachName}</span> (you)
        </p>

        <div className="grid grid-cols-2 gap-3">
          <label className={LABEL}>
            Date
            <input
              className={FIELD}
              type="date"
              value={draft.date}
              onChange={(e) => set({ date: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className={LABEL}>
            Starts
            <input
              className={FIELD}
              type="time"
              value={draft.start}
              onChange={(e) => set({ start: e.target.value })}
              disabled={busy}
            />
          </label>
          <label className={LABEL}>
            Minutes
            <input
              className={FIELD}
              type="number"
              min={CLASS_LIMITS.minutesMin}
              max={CLASS_LIMITS.minutesMax}
              step={1}
              onKeyDown={blockIntJunk}
              value={Number.isNaN(draft.minutes) ? '' : draft.minutes}
              // Blank is "not set" (NaN, refused by the form check), never 0.
              onChange={(e) => set({ minutes: wholeOrNaN(e.target.value) })}
              disabled={busy}
            />
          </label>
          <label className={LABEL}>
            Places
            <input
              className={FIELD}
              type="number"
              min={session === null ? 1 : Math.max(1, session.bookedCount)}
              max={CLASS_LIMITS.placesMax}
              step={1}
              onKeyDown={blockIntJunk}
              value={Number.isNaN(draft.capacity) ? '' : draft.capacity}
              onChange={(e) => set({ capacity: wholeOrNaN(e.target.value) })}
              disabled={busy}
            />
          </label>
        </div>

        {shown === null ? null : (
          <p id={`${ids}-err`} role="alert" className="m-0 text-[13.5px] text-danger">
            {shown}
          </p>
        )}
      </div>

      <SheetFooter className="flex-row justify-end gap-2">
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : session === null ? 'Put it on the timetable' : 'Save changes'}
        </Button>
      </SheetFooter>
    </form>
  );
}

/** Cancelling is not deleting: bookings stay, and everybody booked is told why. */
export function CoachCancelClassDialog({
  session,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  session: ClassSession | null;
  busy: boolean;
  error: string | null;
  onConfirm: (session: ClassSession, reason: string) => void;
  onClose: () => void;
}) {
  return (
    <AlertDialog
      open={session !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <AlertDialogContent>
        {session === null ? null : (
          // Keyed on the class: the reason typed for one class must never
          // open pre-filled on the next. The page closes the dialog by
          // clearing the target, so onOpenChange alone cannot reset it.
          <CancelClassForm
            key={session.id}
            session={session}
            busy={busy}
            error={error}
            onConfirm={onConfirm}
          />
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function CancelClassForm({
  session,
  busy,
  error,
  onConfirm,
}: {
  session: ClassSession;
  busy: boolean;
  error: string | null;
  onConfirm: (session: ClassSession, reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const ready = reason.trim().length >= 3 && reason.trim().length <= 300;

  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle className="font-display">Cancel {session.title}?</AlertDialogTitle>
        <AlertDialogDescription>
          {shortDay(session.businessDate)}, {gymClock12(session.startsAt)}. The class stays on the
          timetable as cancelled, and everybody booked or waiting gets a notice with your reason.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <label className={LABEL}>
        Reason
        <textarea
          rows={3}
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Coach is unwell — sorry, see you Friday."
          className="min-w-0 resize-none rounded-md border border-[color:var(--p-border-2)] bg-card px-3 py-2 text-[14.5px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold"
          disabled={busy}
        />
      </label>
      {error === null ? null : (
        <p role="alert" className="m-0 text-[13.5px] text-danger">
          {error}
        </p>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Keep the class</AlertDialogCancel>
        <AlertDialogAction
          disabled={busy || !ready}
          variant="destructive"
          onClick={(event) => {
            event.preventDefault();
            onConfirm(session, reason.trim());
          }}
        >
          {busy ? 'Cancelling…' : 'Cancel class'}
        </AlertDialogAction>
      </AlertDialogFooter>
    </>
  );
}
