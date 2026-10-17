'use client';

import {
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PERMISSIONS, type ClassRegisterEntryWire } from '@got/shared';
import { registerOpensLabel } from '@/lib/schedule/cancelCopy';
import { shortDay } from '@/lib/schedule/labels';
import { ApiError } from '@/lib/api';
import { adminApi } from '@/lib/adminApi';
import { useAdminQuery, type AdminQuery } from '@/lib/useAdminQuery';
import { classLength, classTime, groupByDay, type ClassSession } from '@/lib/classes';
import {
  markedByLine,
  registerBadge,
  registerIsOpen,
  staffAddOutcome,
  stillWaiting,
  waitlistClosedNote,
  withRegisterCounts,
} from '@/lib/classRegister';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { usePermission } from '@/components/rbac/MeProvider';
import { AddToClassModal } from '@/components/admin/actions/AddToClassModal';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';
import {
  cancelConsequence,
  editConsequence,
  holdersSentence,
  readCoachFilter,
  readWindowStart,
  removeConsequence,
  stepWindow,
  timetableHref,
  timetableWindow,
  windowContaining,
  type ClassPatch,
} from './classesView';

/**
 * The timetable, from the staff side.
 *
 * Reads the SAME `GET /class-sessions` the portal reads — one query, one
 * ordering, so what staff schedule and what members see cannot disagree.
 *
 * Cancelling is not deleting, and the form says so: the class stays, the
 * bookings stay, and everybody who booked or is waiting gets a notice with the
 * reason. A hard delete would make "how many people did that affect"
 * unanswerable.
 *
 * TWO WEEKS AT A TIME, IN THE URL (2026-10-11). The screen used to show the
 * server's default fortnight from today and nothing else, so a register missed
 * last Tuesday could not be reached to put right. Earlier / Today / Later move
 * a fortnight at a time and the window lives in `?from=` (and the coach filter
 * in `?coach=`), so a view survives a refresh and can be sent to somebody.
 */
export default function AdminClassesPage() {
  // `useSearchParams()` must sit under a Suspense boundary or `next build`
  // fails its prerender pass — a rule `next dev` does not enforce. Same note
  // as admin/payments.
  return (
    <Suspense fallback={<Skeleton height={180} />}>
      <ClassesScreen />
    </Suspense>
  );
}

/**
 * A clock that TICKS, every 30 seconds.
 *
 * A render-time Date.now() would freeze every time-gated decision on this
 * screen at the moment it loaded, so a console opened at the start of a shift
 * would still read "Register opens 5:30 PM" at 5:45, and still offer "Cancel
 * class" on a class that started an hour ago — which is the normal case at a
 * front desk, where the screen is opened once and left up all day. 30s is
 * under half a minute of staleness on boundaries nobody watches to the second;
 * the server refuses anything that lands on the wrong side of one anyway.
 */
function useTickingNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * Focus back on the button that opened an inline form once the form closes —
 * what `Modal` does for dialogs — instead of on the page body, where the next
 * Tab starts again from the sidebar.
 *
 * Only when focus was actually LOST with the form. When it closed because
 * another row's Edit opened a new form, that form has already taken focus and
 * keeps it.
 */
function useReturnFocus(open: boolean): RefObject<HTMLButtonElement | null> {
  const ref = useRef<HTMLButtonElement | null>(null);
  const wasOpen = useRef(open);
  useEffect(() => {
    const focusLost = document.activeElement === null || document.activeElement === document.body;
    if (wasOpen.current && !open && focusLost) ref.current?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open]);
  return ref;
}

function ClassesScreen() {
  const router = useRouter();
  const search = useSearchParams();
  // See the note in admin/announcements/page.tsx — same defect, same fix.
  const canManage = usePermission(PERMISSIONS.CLASS_MANAGE);
  // The desk adding a member by hand, or taking one out (2026-10-11).
  const canManageBookings = usePermission(PERMISSIONS.BOOKING_MANAGE);

  const now = useTickingNow();
  const today = gymToday(now, GYM_TIMEZONE);
  const start = readWindowStart(search.get('from'), today);
  /**
   * Filter the timetable to one coach.
   *
   * `GET /class-sessions` has accepted `coachId` since classes shipped and no
   * client had ever sent it, so "what is Ana teaching this fortnight" was a
   * question the console could not answer. Empty string means everybody.
   */
  const coachFilter = readCoachFilter(search.get('coach'));
  const { from, to } = timetableWindow(start);

  const coaches = useAdminQuery(
    useCallback(() => adminApi.members({ role: 'COACH', limit: 100 }), []),
    'class-coaches',
  );

  const [composing, setComposing] = useState(false);
  /**
   * The session being edited, or null. Never open at the same time as
   * `composing`. Its form opens INLINE, under the row that was clicked — it
   * used to replace the toolbar at the top of the page, above wherever the
   * person had scrolled to, so clicking Edit lower down appeared to do nothing.
   */
  const [editing, setEditing] = useState<ClassSession | null>(null);
  const [openRegister, setOpenRegister] = useState<string | null>(null);
  /** Bumped by a saved edit, so an open register reloads (a capacity raise moves people in). */
  const [registerVersion, setRegisterVersion] = useState(0);
  /** Bumped by a create, so the timetable reloads without losing the rows it shows. */
  const [timetableVersion, setTimetableVersion] = useState(0);
  const scheduleRef = useReturnFocus(composing);

  const go = (nextStart: string, nextCoach: string): void => {
    // A form or register left open belongs to rows that are about to leave.
    setEditing(null);
    setOpenRegister(null);
    router.replace(timetableHref(nextStart, nextCoach, today), { scroll: false });
  };

  const coachList = coaches.data?.items ?? [];

  return (
    // `minmax(0, 1fr)`: an `auto` column grows to its widest child's
    // min-content and pushes the page past a phone's width.
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 18 }}>
      <div className="a-toolbar">
        {canManage && !composing ? (
          <button
            ref={scheduleRef}
            type="button"
            className="p-btn p-btn-gold"
            onClick={() => {
              setEditing(null);
              setComposing(true);
            }}
          >
            Schedule a class
          </button>
        ) : null}

        <div
          role="group"
          aria-label="Days shown"
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        >
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            onClick={() => go(stepWindow(start, -1), coachFilter)}
          >
            <span aria-hidden>‹ </span>Earlier
          </button>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={start === today}
            onClick={() => go(today, coachFilter)}
          >
            Today
          </button>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            onClick={() => go(stepWindow(start, 1), coachFilter)}
          >
            Later<span aria-hidden> ›</span>
          </button>
          <span
            aria-live="polite"
            style={{ marginLeft: 4, fontSize: 13.5, fontWeight: 600, color: 'var(--p-ink2)' }}
          >
            {shortDay(from)} – {shortDay(to)}
          </span>
        </div>

        <label style={{ marginLeft: 'auto' }}>
          <span className="a-person-sub">COACH</span>
          <select
            className="a-input"
            value={coachFilter}
            onChange={(event) => go(start, event.target.value)}
          >
            <option value="">All coaches</option>
            {coachList.map((coach) => (
              <option key={coach.userId} value={coach.userId}>
                {coach.firstName} {coach.lastName}
              </option>
            ))}
          </select>
        </label>
      </div>

      {composing ? (
        <Composer
          key="new"
          session={null}
          now={now}
          coaches={coachList}
          onSaved={(created) => {
            setComposing(false);
            setTimetableVersion((version) => version + 1);
            if (created === null) return;
            // A class scheduled outside what is on screen would otherwise
            // seem to vanish on save. Move to it — the window on the same
            // two-week grid, and every coach if the filter would hide it.
            const outside = created.businessDate < from || created.businessDate > to;
            const hidden = coachFilter !== '' && coachFilter !== created.coachId;
            if (outside || hidden) {
              go(
                outside ? windowContaining(start, created.businessDate) : start,
                hidden ? '' : coachFilter,
              );
            }
          }}
          onCancel={() => setComposing(false)}
        />
      ) : null}

      {/* KEYED BY THE WINDOW. Each fortnight gets its own query, so paging
          shows a skeleton and then that fortnight, instead of last
          fortnight's rows under this fortnight's dates while the request is
          in flight — and a failed page shows its error instead of stale rows. */}
      <TimetableQuery
        key={`${from}|${coachFilter}`}
        from={from}
        to={to}
        coachId={coachFilter}
        version={timetableVersion}
      >
        {(timetable) =>
          timetable.loading && timetable.data === null ? (
            <Skeleton height={180} />
          ) : timetable.error !== null ? (
            <EmptyState title="Could not load the timetable" hint={timetable.error} />
          ) : (timetable.data?.length ?? 0) === 0 ? (
            <EmptyState
              title="Nothing scheduled"
              hint={
                to < today
                  ? 'No classes ran in these two weeks.'
                  : canManage
                    ? 'Press “Schedule a class” members see it on their timetable straight away.'
                    : 'Nothing is on the timetable for these two weeks yet.'
              }
            />
          ) : (
            groupByDay(timetable.data ?? []).map((day) => (
              <section key={day.date} style={{ display: 'grid', gap: 10 }}>
                <div
                  className="a-person-sub"
                  style={{ letterSpacing: '0.09em', textTransform: 'uppercase' }}
                >
                  {day.date === today ? `Today · ${day.label}` : day.label}
                </div>

                {day.sessions.map((session) => (
                  <Fragment key={session.id}>
                    <SessionRow
                      session={session}
                      now={now}
                      canManage={canManage}
                      canManageBookings={canManageBookings}
                      editing={editing?.id === session.id}
                      registerOpen={openRegister === session.id}
                      registerVersion={registerVersion}
                      onToggleRegister={() =>
                        setOpenRegister(openRegister === session.id ? null : session.id)
                      }
                      onEdit={() => {
                        setComposing(false);
                        setEditing(session);
                      }}
                      onChanged={timetable.reload}
                    />

                    {editing?.id === session.id ? (
                      <Composer
                        key={`edit-${session.id}`}
                        session={editing}
                        now={now}
                        coaches={coachList}
                        onSaved={() => {
                          setEditing(null);
                          // An open register reloads: raising the places can
                          // move people off its waitlist.
                          setRegisterVersion((version) => version + 1);
                          timetable.reload();
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    ) : null}
                  </Fragment>
                ))}
              </section>
            ))
          )
        }
      </TimetableQuery>
    </div>
  );
}

/**
 * One fortnight's `GET /class-sessions`, handed to its children.
 *
 * A component of its own only so the page can KEY it by the window: a fresh
 * `useAdminQuery` per window starts in its loading state, where one shared
 * query would keep the previous window's rows on screen (and swallow a failed
 * page's error, since a query that already holds data does not report one).
 * `version` reloads the same window in place.
 */
function TimetableQuery({
  from,
  to,
  coachId,
  version,
  children,
}: {
  from: string;
  to: string;
  coachId: string;
  version: number;
  children: (timetable: AdminQuery<ClassSession[]>) => ReactNode;
}) {
  const timetable = useAdminQuery(
    useCallback(
      () => adminApi.classSessions(coachId === '' ? { from, to } : { from, to, coachId }),
      [from, to, coachId],
    ),
    `class-sessions:${from}:${to}:${coachId}:${version}`,
  );
  return <>{children(timetable)}</>;
}

function SessionRow({
  session,
  now,
  canManage,
  canManageBookings,
  editing,
  registerOpen,
  registerVersion,
  onToggleRegister,
  onEdit,
  onChanged,
}: {
  session: ClassSession;
  now: Date;
  canManage: boolean;
  canManageBookings: boolean;
  /** Its edit form is open, under this row. */
  editing: boolean;
  registerOpen: boolean;
  registerVersion: number;
  onToggleRegister: () => void;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [cancelling, setCancelling] = useState(false);
  const { busy, error, run, reset } = useConfirmAction();
  const cancelled = session.cancelledAt !== null;
  const started = now.getTime() >= new Date(session.startsAt).getTime();
  const ended = now.getTime() >= new Date(session.endsAt).getTime();
  // Only while the queue can still move: once the class starts, the register
  // reads "No place" on each of those rows.
  const waiting = stillWaiting(session, now);

  const editRef = useReturnFocus(editing);

  /**
   * The reason is asked for in the console's one confirmation dialog: the
   * server requires 3–300 characters and every member booked or waiting gets
   * it in a notice. A failure stays in the dialog with the server's message —
   * it used to reject into nothing.
   */
  const doCancel = (reason: string | undefined): void => {
    if (reason === undefined) return;
    void run(() => adminApi.cancelClassSession(session.id, reason)).then((ok) => {
      if (!ok) return;
      reset();
      setCancelling(false);
      onChanged();
    });
  };

  return (
    <Card style={cancelled ? { opacity: 0.62 } : undefined}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 15.5 }}>{session.title}</strong>
            {cancelled ? <Badge tone="danger">Cancelled</Badge> : null}
            {!cancelled && started && !ended ? <Badge tone="info">On now</Badge> : null}
            {!cancelled && ended ? <Badge tone="neutral">Finished</Badge> : null}
            {!cancelled && !ended && session.isFull ? <Badge tone="warn">Full</Badge> : null}
          </div>
          {/* Wraps rather than truncating: on a phone the waitlist count is
              the part that would otherwise disappear behind an ellipsis. */}
          <div className="a-person-sub" style={{ marginTop: 3, whiteSpace: 'normal' }}>
            {classTime(session.startsAt)} · {classLength(session.startsAt, session.endsAt)} ·{' '}
            {session.coachName} · {session.bookedCount}/{session.capacity} booked
            {waiting > 0 ? ` · ${waiting} waiting` : null}
          </div>
          {cancelled ? (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--p-danger)' }}>
              {session.cancelReason}
            </p>
          ) : null}
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {/* Not for a class the gym called off: there is nothing to mark,
              and the server refuses every mark with CLASS_CANCELLED. */}
          {cancelled ? null : (
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              aria-expanded={registerOpen}
              onClick={onToggleRegister}
            >
              {registerOpen ? 'Hide register' : 'Register'}
            </button>
          )}

          {/* REQ013's "modify". Hidden once a class is cancelled — a cancelled
              session is a historical record with bookings attached to it, and
              editing its time would rewrite what the people who booked were
              told — and once it has ENDED, for the same reason (the server
              refuses with CLASS_FINISHED). Hidden too while its form is open
              below: a second click would throw away what was typed. */}
          {canManage && !cancelled && !ended && !editing ? (
            <button
              ref={editRef}
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={onEdit}
            >
              Edit
            </button>
          ) : null}

          {/* `class.manage` — the key the cancel route checks. The desk marks
              registers here but cannot cancel, so it no longer sees a Cancel
              button that 403s. Gone once the class has STARTED: people are in
              the room, and the server refuses with CLASS_ALREADY_STARTED. */}
          {cancelled || started || !canManage ? null : (
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => setCancelling(true)}
            >
              Cancel class
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={cancelling}
        title={`Cancel “${session.title}” at ${classTime(session.startsAt)}?`}
        consequence={cancelConsequence(session.bookedCount, session.waitlistCount)}
        confirmLabel="Cancel the class"
        cancelLabel="Keep the class"
        tone="danger"
        reason={{
          required: true,
          label: 'Reason members will see this',
          maxLength: 300,
          placeholder: 'e.g. Coach unwell — sorry, see you Thursday',
        }}
        busy={busy}
        error={error}
        onConfirm={doCancel}
        onClose={() => {
          if (busy) return;
          reset();
          setCancelling(false);
        }}
      />

      {/* `!cancelled` as well as `registerOpen`: a register opened before the
          class was cancelled must unmount with the reload, not linger with
          buttons the server refuses. */}
      {registerOpen && !cancelled ? (
        <Register
          session={session}
          now={now}
          version={registerVersion}
          canManage={canManage}
          canManageBookings={canManageBookings}
          onChanged={onChanged}
        />
      ) : null}
    </Card>
  );
}

/** A register mark waiting on its confirmation. */
interface PendingMark {
  bookingId: string;
  name: string;
  attended: boolean;
  /** The entry is already marked the other way, and this puts it right. */
  correcting: boolean;
}

/**
 * Who is in the class, and the register staff mark.
 *
 * Every write here is confirmed (owner decision: every staff write is,
 * the register included) and followed by a reload — unlike the coach's
 * register, which marks in one tap. The rows come back in a fixed order —
 * seated and marked first, in the order they booked, then the waitlist in
 * queue order — so a reload never moves the row somebody just marked.
 */
function Register({
  session,
  now,
  version,
  canManage,
  canManageBookings,
  onChanged,
}: {
  session: ClassSession;
  /** The page's ticking clock. */
  now: Date;
  /** Bumped when the class is edited; a new value reloads the register. */
  version: number;
  canManage: boolean;
  canManageBookings: boolean;
  /** Seats moved: the timetable's counts and Full badge reload with it. */
  onChanged: () => void;
}) {
  const register = useAdminQuery(
    useCallback(() => adminApi.classRegister(session.id), [session.id]),
    `register-${session.id}:${version}`,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [marking, setMarking] = useState<PendingMark | null>(null);
  const markConfirm = useConfirmAction();
  const [removing, setRemoving] = useState<ClassRegisterEntryWire | null>(null);
  const removeConfirm = useConfirmAction();
  const [adding, setAdding] = useState(false);

  // The server refuses marks before this; the buttons do not pretend otherwise.
  const markable = registerIsOpen(session.startsAt, now);
  const started = now.getTime() >= new Date(session.startsAt).getTime();
  const ended = now.getTime() >= new Date(session.endsAt).getTime();

  const mark = (): void => {
    if (marking === null) return;
    const { bookingId, attended } = marking;
    setBusy(bookingId);
    void markConfirm
      .run(() => adminApi.markAttendance(bookingId, attended))
      .then((ok) => {
        setBusy(null);
        if (!ok) return;
        markConfirm.reset();
        setMarking(null);
        register.reload();
      });
  };

  const remove = (reason: string | undefined): void => {
    if (removing === null || reason === undefined) return;
    const { bookingId } = removing;
    void removeConfirm
      .run(() => adminApi.removeFromClass(bookingId, reason))
      .then((ok) => {
        if (!ok) return;
        removeConfirm.reset();
        setRemoving(null);
        register.reload();
        onChanged();
      });
  };

  if (register.loading && register.data === null) return <Skeleton height={70} />;
  // An error is not an empty register: "nobody has booked" here once hid a
  // failed load behind a sentence that sounded like an answer.
  if (register.data === null) {
    return (
      <p style={{ margin: '12px 0 0', fontSize: 13.5, color: 'var(--p-danger)' }}>
        {register.error ?? 'Could not load the register.'}
      </p>
    );
  }

  const rows = register.data;
  // The add preview reads the seats off these rows, not off the timetable row
  // this register was opened from. That row is as old as the page: a member
  // who cancelled since (after the waitlist closed, say) freed a seat the rows
  // below show, and "Add a member" sat disabled as full beside it. The modal
  // gets the same counts, so its preview and its "#3 on the waitlist" agree.
  const live = withRegisterCounts(session, rows);
  const addOutcome = staffAddOutcome(live, now);
  const closedNote = waitlistClosedNote(session.startsAt, live.waitlistCount, now);

  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
      {/* Until the class ENDS — a walk-in may join one that is running. */}
      {canManageBookings && addOutcome !== 'FINISHED' && addOutcome !== 'CANCELLED' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={addOutcome === 'WAITLIST_CLOSED'}
            onClick={() => setAdding(true)}
          >
            Add a member
          </button>
          {addOutcome === 'WAITLIST_CLOSED' ? (
            <span className="a-person-sub" style={{ whiteSpace: 'normal' }}>
              {canManage
                ? 'Full, and the waitlist has closed. Raise the places with Edit to add somebody.'
                : 'Full, and the waitlist has closed. An admin can raise the places.'}
            </span>
          ) : null}
        </div>
      ) : null}

      {closedNote === null ? null : (
        <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.5, color: 'var(--p-ink2)' }}>
          {closedNote}
        </p>
      )}

      {rows.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--p-ink3)' }}>
          {ended ? 'Nobody booked this class.' : 'Nobody has booked this yet.'}
        </p>
      ) : (
        rows.map((entry) => {
          const name = `${entry.member.firstName} ${entry.member.lastName}`;
          const badge = registerBadge(entry, session.startsAt, now);
          const marker = markedByLine(entry, session.businessDate);
          // Staff cannot remove a marked entry (mark the other way instead),
          // nor anybody once the class has started — then it is a no-show.
          const removable =
            canManageBookings &&
            !started &&
            (entry.status === 'BOOKED' || entry.status === 'WAITLISTED');

          return (
            <div
              key={entry.bookingId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
                paddingTop: 8,
                borderTop: '1px solid var(--p-border)',
              }}
            >
              <span style={{ flex: '1 1 160px', minWidth: 0, fontSize: 14 }}>
                {name}
                {entry.member.memberCode === null ? null : (
                  <span className="a-person-sub"> · {entry.member.memberCode}</span>
                )}
                {entry.addedByStaff ? (
                  <span className="a-person-sub" style={{ display: 'block', marginTop: 2 }}>
                    Added by the desk
                  </span>
                ) : null}
                {marker === null ? null : (
                  <span className="a-person-sub" style={{ display: 'block', marginTop: 2 }}>
                    {marker}
                  </span>
                )}
              </span>

              {badge === null ? null : <Badge tone={badge.tone}>{badge.label}</Badge>}

              {entry.status === 'WAITLISTED' ? null : markable ? (
                // A marked entry offers only the other mark: the correction.
                <span style={{ display: 'inline-flex', gap: 6 }}>
                  {entry.status === 'ATTENDED' ? null : (
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      disabled={busy === entry.bookingId}
                      onClick={() =>
                        setMarking({
                          bookingId: entry.bookingId,
                          name,
                          attended: true,
                          correcting: entry.status === 'NO_SHOW',
                        })
                      }
                    >
                      Here
                    </button>
                  )}
                  {entry.status === 'NO_SHOW' ? null : (
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      disabled={busy === entry.bookingId}
                      onClick={() =>
                        setMarking({
                          bookingId: entry.bookingId,
                          name,
                          attended: false,
                          correcting: entry.status === 'ATTENDED',
                        })
                      }
                    >
                      No show
                    </button>
                  )}
                </span>
              ) : (
                <span className="a-person-sub">{registerOpensLabel(session.startsAt, now)}</span>
              )}

              {removable ? (
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => {
                    removeConfirm.reset();
                    setRemoving(entry);
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          );
        })
      )}

      <ConfirmDialog
        open={marking !== null}
        title={
          marking === null
            ? ''
            : marking.attended
              ? marking.correcting
                ? `Change ${marking.name} to here?`
                : `Mark ${marking.name} as here?`
              : marking.correcting
                ? `Change ${marking.name} to a no-show?`
                : `Mark ${marking.name} as a no-show?`
        }
        consequence={
          marking?.correcting === true
            ? "Replaces the earlier mark on this class's register, in your name."
            : marking?.attended === false
              ? "Recorded on this class's register as not attending, in your name."
              : "Recorded on this class's register as attended, in your name."
        }
        confirmLabel={marking?.attended === false ? 'Mark no-show' : 'Mark here'}
        cancelLabel={marking?.correcting === true ? 'Keep the mark' : 'Leave unmarked'}
        busy={markConfirm.busy}
        error={markConfirm.error}
        onConfirm={mark}
        onClose={() => {
          if (markConfirm.busy) return;
          markConfirm.reset();
          setMarking(null);
        }}
      />

      <ConfirmDialog
        open={removing !== null}
        title={
          removing === null
            ? ''
            : `Take ${removing.member.firstName} ${removing.member.lastName} out of “${session.title}”?`
        }
        consequence={
          removing === null ? '' : removeConsequence(removing, removing.member.firstName, live, now)
        }
        confirmLabel="Remove from class"
        cancelLabel={removing?.status === 'WAITLISTED' ? 'Keep them waiting' : 'Keep them in'}
        tone="danger"
        reason={{
          required: true,
          // The member reads it in their notice: `@Length(3, 300)` on the
          // route and the same bounds in the row's CHECK.
          label: `Reason — ${removing?.member.firstName ?? 'the member'} will see this`,
          maxLength: 300,
          placeholder: 'e.g. Booked twice by mistake — the other booking stands',
        }}
        busy={removeConfirm.busy}
        error={removeConfirm.error}
        onConfirm={remove}
        onClose={() => {
          if (removeConfirm.busy) return;
          removeConfirm.reset();
          setRemoving(null);
        }}
      />

      <AddToClassModal
        open={adding}
        session={live}
        now={now}
        onClose={() => setAdding(false)}
        onAdded={() => {
          register.reload();
          onChanged();
        }}
      />
    </div>
  );
}

/** `2026-08-26T10:00:00.000Z` → `18:00` in the gym's own zone. */
function gymClock(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: GYM_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

/**
 * Schedule a class, or edit one — REQ013's create and modify in one form.
 *
 * ONE COMPONENT, NOT TWO. A separate edit form would be the same six fields
 * and the same gym-local-to-instant conversion written a second time, and the
 * two would drift the first time a field was added to either. The only
 * difference is which call it makes and which words the buttons carry, so
 * that is the only thing branched on.
 *
 * The edit path sends ONLY the fields that changed. `forbidNonWhitelisted` is
 * global, so an unknown property is a 400 — and resending an untouched value
 * would bump `updatedAt`, make the history lie about when somebody last
 * touched the class, and now send everybody in it a "changed" notice about
 * nothing.
 */
function Composer({
  session,
  now,
  coaches,
  onSaved,
  onCancel,
}: {
  /** Null to create. A session to edit it. */
  session: ClassSession | null;
  /** The page's ticking clock — whether a capacity raise still moves the waitlist. */
  now: Date;
  coaches: { userId: string; firstName: string; lastName: string }[];
  /** The created or updated class, or null when an edit changed nothing. */
  onSaved: (saved: ClassSession | null) => void;
  onCancel: () => void;
}) {
  const editing = session !== null;

  const [title, setTitle] = useState(session?.title ?? '');
  const [coachId, setCoachId] = useState(session?.coachId ?? '');
  const [date, setDate] = useState(session?.businessDate ?? '');
  const [start, setStart] = useState(session === null ? '18:00' : gymClock(session.startsAt));
  const [minutes, setMinutes] = useState(
    session === null
      ? 60
      : Math.round(
          (new Date(session.endsAt).getTime() - new Date(session.startsAt).getTime()) / 60_000,
        ),
  );
  const [capacity, setCapacity] = useState(session?.capacity ?? 16);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The earliest day the date picker offers: today, gym time. The server
   * refuses a start that has passed (CLASS_ALREADY_STARTED, shown as it is
   * sent); this only stops the picker offering last week. An edit keeps its
   * own day when that is earlier — a class running past midnight — or the
   * browser would refuse to submit the form at all.
   */
  const today = gymToday(now, GYM_TIMEZONE);
  const earliestDay =
    session !== null && session.businessDate < today ? session.businessDate : today;
  // Members book off the timetable, so a create or edit is confirmed first.
  const [confirming, setConfirming] = useState(false);

  /**
   * Into view and focused on open. `.a-class-form`'s scroll margins keep it
   * clear of the sticky topbar above and, on a phone, of the fixed tab bar
   * below — which used to sit over "Save changes". `nearest` scrolls only as
   * far as it must, so the row that was clicked stays on screen above an edit
   * form that fits. Re-runs on every open, because each one mounts a fresh form.
   */
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    anchorRef.current?.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'nearest',
    });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * The form collects a gym-local date and time; the API takes instants.
   * `+08:00` is written explicitly rather than relying on the browser's zone —
   * a manager scheduling from a laptop set to another country must still
   * create the class at 6pm Manila. Null while the date is not filled in.
   */
  const instants = (): { startsAt: string; endsAt: string } | null => {
    const startsAt = new Date(`${date}T${start}:00+08:00`);
    if (Number.isNaN(startsAt.getTime())) return null;
    return {
      startsAt: startsAt.toISOString(),
      endsAt: new Date(startsAt.getTime() + minutes * 60_000).toISOString(),
    };
  };

  /**
   * Only what moved. Times are compared as instants, so re-picking the same
   * time from the two inputs is correctly seen as no change; the title is
   * compared trimmed, because the server trims it and a stray space is not a
   * change worth telling anybody about.
   */
  const changes = (
    target: ClassSession,
    times: { startsAt: string; endsAt: string },
  ): ClassPatch => {
    const patch: ClassPatch = {};
    if (title.trim() !== target.title) patch.title = title.trim();
    if (coachId !== target.coachId) patch.coachId = coachId;
    if (times.startsAt !== target.startsAt) patch.startsAt = times.startsAt;
    if (times.endsAt !== target.endsAt) patch.endsAt = times.endsAt;
    if (capacity !== target.capacity) patch.capacity = capacity;
    return patch;
  };

  const submit = async (): Promise<void> => {
    const times = instants();
    if (times === null) {
      setError('Pick a date and a start time.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let saved: ClassSession | null = null;
      if (session === null) {
        saved = await adminApi.createClassSession({
          title: title.trim(),
          coachId,
          startsAt: times.startsAt,
          endsAt: times.endsAt,
          capacity,
        });
      } else {
        const patch = changes(session, times);
        // Nothing changed. Closing without a request is the honest outcome —
        // a PATCH with an empty body would still touch `updatedAt`.
        if (Object.keys(patch).length > 0) {
          saved = await adminApi.updateClassSession(session.id, patch);
        }
      }
      setConfirming(false);
      onSaved(saved);
    } catch (caught) {
      // The server's own sentence, never a code mapped to ours: a start that
      // has passed (CLASS_ALREADY_STARTED), an end that has (CLASS_FINISHED)
      // and places below the bookings each say what to fix.
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const ready = title.trim() !== '' && coachId !== '' && date !== '';

  // What the confirmation says the save will do — worked out from the actual
  // changes, so "they get a notice" appears only when one is sent.
  const preview = (() => {
    if (session === null) {
      return {
        consequence: 'Members can see and book it on the timetable straight away.',
        facts: [] as string[],
      };
    }
    const times = instants();
    return editConsequence(session, times === null ? {} : changes(session, times), now);
  })();

  // Once the class is running a change is news to the seats only, as on the
  // server: a waitlist place on a running class is no place at all.
  const waitingTold = session === null ? 0 : stillWaiting(session, now);
  const holders = session === null ? null : holdersSentence(session.bookedCount, waitingTold);

  return (
    <div ref={anchorRef} className="a-class-form">
      <Card style={{ borderColor: 'var(--gold)' }}>
        <CardHead
          as="h2"
          headingRef={headingRef}
          title={editing ? `Edit “${session.title}”` : 'Schedule a class'}
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onCancel}>
              Cancel
            </button>
          }
        />

        {holders === null ? null : (
          <p style={{ margin: '0 0 12px', fontSize: 13, color: 'var(--p-ink2)', lineHeight: 1.55 }}>
            {holders} Changing the time, the coach or the name sends{' '}
            {session !== null && session.bookedCount + waitingTold === 1 ? 'them' : 'each of them'}{' '}
            a notice in the app.
          </p>
        )}

        <form
          className="a-sheet"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setConfirming(true);
          }}
        >
          <label>
            <span className="a-person-sub">CLASS</span>
            <input
              className="a-input"
              value={title}
              required
              maxLength={80}
              placeholder="HIIT Conditioning"
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>

          <label>
            <span className="a-person-sub">COACH</span>
            <select
              className="a-input"
              value={coachId}
              required
              onChange={(event) => setCoachId(event.target.value)}
            >
              <option value="">Choose a coach…</option>
              {coaches.map((coach) => (
                <option key={coach.userId} value={coach.userId}>
                  {coach.firstName} {coach.lastName}
                </option>
              ))}
            </select>
          </label>

          <div className="a-toolbar">
            <label>
              <span className="a-person-sub">DATE</span>
              <input
                className="a-input"
                type="date"
                value={date}
                min={earliestDay}
                required
                onChange={(event) => setDate(event.target.value)}
              />
            </label>
            <label>
              <span className="a-person-sub">STARTS</span>
              <input
                className="a-input"
                type="time"
                value={start}
                required
                onChange={(event) => setStart(event.target.value)}
              />
            </label>
            <label>
              <span className="a-person-sub">MINUTES</span>
              <input
                className="a-input"
                type="number"
                min={10}
                max={300}
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
              />
            </label>
            <label>
              <span className="a-person-sub">PLACES</span>
              {/* Not below the places already taken: the server refuses that
                  (CAPACITY_BELOW_BOOKED), and the browser can say so first. */}
              <input
                className="a-input"
                type="number"
                min={session === null ? 1 : Math.max(1, session.bookedCount)}
                max={500}
                value={capacity}
                onChange={(event) => setCapacity(Number(event.target.value))}
              />
            </label>
          </div>

          {error === null ? null : (
            <p style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>{error}</p>
          )}

          <button type="submit" className="p-btn p-btn-gold" disabled={busy || !ready}>
            {busy
              ? editing
                ? 'Saving…'
                : 'Scheduling…'
              : editing
                ? 'Save changes'
                : 'Put it on the timetable'}
          </button>
        </form>

        <ConfirmDialog
          open={confirming}
          title={
            editing
              ? `Save changes to “${title.trim()}”?`
              : `Put “${title.trim()}” on the timetable?`
          }
          consequence={preview.consequence}
          confirmLabel={editing ? 'Save changes' : 'Put it on the timetable'}
          cancelLabel="Keep editing"
          busy={busy}
          error={error}
          onConfirm={() => void submit()}
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
        >
          <ul className="a-confirm-facts">
            <li>
              {date === '' ? '—' : date} at {start} · {minutes} minutes · {capacity} places
            </li>
            <li>
              Coach:{' '}
              {(() => {
                const coach = coaches.find((candidate) => candidate.userId === coachId);
                return coach === undefined ? '—' : `${coach.firstName} ${coach.lastName}`;
              })()}
            </li>
            {preview.facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
        </ConfirmDialog>
      </Card>
    </div>
  );
}
