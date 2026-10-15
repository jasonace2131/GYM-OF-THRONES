'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ClassRegisterEntryWire } from '@got/shared';
import { Badge, EmptyState, Skeleton } from '@/components/portal/ui';
import { ApiError } from '@/lib/api';
import { markedByLine, registerBadge, registerIsOpen } from '@/lib/classRegister';
import { coachApi, type CoachSession } from '@/lib/coachApi';
import { registerOpensLabel } from '@/lib/schedule/cancelCopy';
import { cn } from '@/lib/utils';

export interface ClassRegisterListProps {
  /** The class: which one, when it starts, its gym day, and whether the gym called it off. */
  session: Pick<CoachSession, 'id' | 'startsAt' | 'businessDate' | 'cancelledAt'>;
  /**
   * The parent's ticking clock. Ticking matters: a register sits open for a
   * whole session, and a render-time Date.now() would leave the buttons
   * hidden past the moment the register opens.
   */
  now: Date;
  /** After a mark lands, so the counts elsewhere on the page can follow. */
  onMarked?: () => void;
  /**
   * A new value refetches the roster in the background (the rows on screen
   * stay until the answer lands). For a register that another copy of itself
   * may have changed — the same class marked in the session sheet.
   */
  version?: number;
}

/**
 * One class's register, as a coach takes it — on the dashboard for today's
 * sessions, and in the session sheet for ANY session whose register has
 * opened, past days included (2026-10-11). It used to live inside the
 * dashboard's "Today" card, so a register missed yesterday could not be
 * reached to put right; the server never had a today-only rule.
 *
 * Marking is deliberately two buttons rather than a checkbox: "attended" and
 * "no-show" are different facts, and a cleared checkbox cannot tell "did not
 * come" from "not marked yet". It is one tap, unconfirmed — the console
 * confirms each mark; a coach working down a room of twenty does not — and
 * the row is patched in place from the answer, which carries the marker and
 * the time, so the "Marked by" line appears without a reload.
 *
 * Mount it with `key={session.id}`: the roster belongs to one session.
 */
export function ClassRegisterList({ session, now, onMarked, version = 0 }: ClassRegisterListProps) {
  const [roster, setRoster] = useState<ClassRegisterEntryWire[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /** Bumped by "Try again" after a failed load. */
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    coachApi.register(session.id).then(
      (rows) => {
        if (cancelled) return;
        setRoster(rows);
        setLoadFailed(false);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [session.id, attempt, version]);

  const mark = useCallback(
    async (bookingId: string, attended: boolean): Promise<void> => {
      setBusy(bookingId);
      setFailure(null);
      try {
        const result = await coachApi.markAttendance(bookingId, attended);
        // Patched in place: a full reload would collapse the row the coach is
        // working down. The dashboard's counts DO reload, through onMarked.
        setRoster(
          (current) =>
            current?.map((row) =>
              row.bookingId === bookingId
                ? {
                    ...row,
                    status: result.status,
                    markedAt: result.markedAt,
                    markedBy: result.markedBy,
                  }
                : row,
            ) ?? null,
        );
        onMarked?.();
      } catch (caught) {
        // The server's sentence when there is one ("The register opens at
        // 5:30 PM."); it is written for the person holding the phone.
        setFailure(caught instanceof ApiError ? caught.message : 'That did not save. Try again.');
      } finally {
        setBusy(null);
      }
    },
    [onMarked],
  );

  // The server refuses every mark on a class the gym called off. The callers
  // do not offer a cancelled class's register; this is the backstop.
  if (session.cancelledAt !== null) {
    return (
      <p className="m-0 text-[13px] text-ink-3">
        This class was cancelled, so there is no register to take.
      </p>
    );
  }

  if (roster === null) {
    return loadFailed ? (
      <p role="alert" className="m-0 flex flex-wrap items-center gap-2 text-[12.5px] text-danger">
        Could not load the register.
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          onClick={() => {
            setLoadFailed(false);
            setAttempt((count) => count + 1);
          }}
        >
          Try again
        </button>
      </p>
    ) : (
      <Skeleton height={80} />
    );
  }

  const markable = registerIsOpen(session.startsAt, now);

  return (
    <div className="grid gap-2">
      {failure !== null ? (
        <p role="alert" className="m-0 text-[12.5px] text-danger">
          {failure}
        </p>
      ) : null}

      {roster.length === 0 ? (
        <EmptyState title="Nobody booked" hint="An empty register is not a no-show." />
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0">
          {roster.map((row) => {
            // Marked rows show as the pressed button, so only a waitlist row
            // needs a badge: its queue place, or "No place" once it started.
            const badge =
              row.status === 'WAITLISTED' ? registerBadge(row, session.startsAt, now) : null;
            const marker = markedByLine(row, session.businessDate);

            return (
              <li key={row.bookingId} className="flex flex-wrap items-center gap-2.5">
                <span className="grid min-w-[140px] gap-0.5">
                  <span>
                    {row.member.firstName} {row.member.lastName}
                    {row.member.memberCode === null ? null : (
                      <span className="ml-1.5 text-[12px] text-ink-3">{row.member.memberCode}</span>
                    )}
                  </span>
                  {row.addedByStaff ? (
                    <span className="text-[12px] text-ink-3">Added by the desk</span>
                  ) : null}
                  {marker === null ? null : (
                    <span className="text-[12px] text-ink-3">{marker}</span>
                  )}
                </span>

                {badge === null ? null : <Badge tone={badge.tone}>{badge.label}</Badge>}

                {row.status === 'WAITLISTED' ? null : markable ? (
                  <span className="ml-auto flex gap-1.5">
                    <button
                      type="button"
                      disabled={busy === row.bookingId}
                      aria-pressed={row.status === 'ATTENDED'}
                      className={cn(
                        'p-btn p-btn-sm',
                        row.status === 'ATTENDED' ? 'p-btn-gold' : 'p-btn-ghost',
                      )}
                      onClick={() => void mark(row.bookingId, true)}
                    >
                      Attended
                    </button>
                    <button
                      type="button"
                      disabled={busy === row.bookingId}
                      aria-pressed={row.status === 'NO_SHOW'}
                      className={cn(
                        'p-btn p-btn-sm',
                        row.status === 'NO_SHOW' ? 'p-btn-dark' : 'p-btn-ghost',
                      )}
                      onClick={() => void mark(row.bookingId, false)}
                    >
                      No-show
                    </button>
                  </span>
                ) : (
                  <span className="ml-auto text-[12.5px] text-ink-3">
                    {registerOpensLabel(session.startsAt, now)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
