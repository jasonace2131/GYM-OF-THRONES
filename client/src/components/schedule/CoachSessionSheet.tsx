'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { registerIsOpen } from '@/lib/classRegister';
import type { CoachSession } from '@/lib/coachApi';
import { registerOpensLabel } from '@/lib/schedule/cancelCopy';
import { gymClock12 } from '@/lib/schedule/gymClock';
import { longDay } from '@/lib/schedule/labels';
import { cn } from '@/lib/utils';
import { ClassRegisterList } from './ClassRegisterList';
import { StatusBadge } from './StatusBadge';

interface CoachSessionSheetProps {
  session: CoachSession | null;
  /** The dashboard's ticking clock — "Open register" enables itself when the register opens. */
  now: Date;
  side: 'bottom' | 'right';
  onClose: () => void;
  /** After a mark in the sheet's register, so the dashboard's counts follow. */
  onMarked: () => void;
}

/**
 * One session from the coach's week grid, and its register.
 *
 * The register opens HERE, for any class the gym has not cancelled whose
 * register has opened — past days included (2026-10-11). It used to be
 * offered for today's sessions only, and only as a scroll to the dashboard's
 * "Today" card, so a register missed on Tuesday could never be put right on
 * Wednesday, although nothing on the server had ever said so.
 */
export function CoachSessionSheet({
  session,
  now,
  side,
  onClose,
  onMarked,
}: CoachSessionSheetProps) {
  /**
   * Which session's register is open. Keyed by id rather than a boolean, so
   * opening a different session starts collapsed without an effect to reset it.
   */
  const [registerFor, setRegisterFor] = useState<string | null>(null);
  const markable = session !== null && registerIsOpen(session.startsAt, now);
  const registerOpen =
    session !== null && session.cancelledAt === null && registerFor === session.id;

  const close = (): void => {
    setRegisterFor(null);
    onClose();
  };

  return (
    <Sheet
      open={session !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <SheetContent
        side={side}
        // Scrolls inside itself: a full class's register is longer than a
        // phone's bottom sheet, and the page behind it is locked.
        className={cn(
          'overflow-y-auto',
          side === 'bottom' ? 'max-h-[90dvh] rounded-t-2xl' : 'w-[380px] sm:max-w-[380px]',
        )}
      >
        {session === null ? null : (
          <>
            <SheetHeader>
              <SheetTitle className="font-display text-xl">{session.title}</SheetTitle>
              <SheetDescription>
                {longDay(session.businessDate)}, {gymClock12(session.startsAt)}–
                {gymClock12(session.endsAt)}
              </SheetDescription>
            </SheetHeader>

            <div className="grid gap-3 px-4">
              {session.cancelledAt !== null ? (
                <div className="grid gap-1">
                  <StatusBadge tone="danger">Cancelled</StatusBadge>
                  <p className="text-sm text-danger">{session.cancelReason}</p>
                </div>
              ) : null}
              <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-ink-3">Booked</dt>
                <dd>
                  {session.bookedCount} of {session.capacity}
                </dd>
                <dt className="text-ink-3">Register</dt>
                <dd>
                  {markable
                    ? `${session.marked} of ${session.bookedCount} marked`
                    : registerOpensLabel(session.startsAt, now).replace('Register opens', 'Opens')}
                </dd>
              </dl>

              {registerOpen ? (
                <section
                  aria-label={`Register for ${session.title}`}
                  className="border-t border-border pt-3"
                >
                  <ClassRegisterList
                    key={session.id}
                    session={session}
                    now={now}
                    onMarked={onMarked}
                  />
                </section>
              ) : null}
            </div>

            <SheetFooter className="flex-row gap-2 pb-[calc(16px+env(safe-area-inset-bottom,0px))]">
              {session.cancelledAt === null && !registerOpen ? (
                <Button disabled={!markable} onClick={() => setRegisterFor(session.id)}>
                  {markable ? 'Open register' : registerOpensLabel(session.startsAt, now)}
                </Button>
              ) : null}
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
