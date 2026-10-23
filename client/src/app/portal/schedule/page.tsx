'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { CLASS_BOOKING_WINDOW_DAYS, PERMISSIONS } from '@got/shared';
import { useMe, usePermission } from '@/components/rbac/MeProvider';
import { adminApi } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import {
  canCancelClass,
  canEditClass,
  createBody,
  patchFor,
  type ClassDraft,
} from '@/lib/schedule/coachClasses';
import { classesApi, type ClassSession, type MyBooking, type MyBookingWindow } from '@/lib/classes';
import { bookingErrorMessage, isBookingRefusal } from '@/lib/schedule/bookingErrors';
import { bookingState, holdsPlace } from '@/lib/schedule/bookingState';
import { windowBanner, windowCoverageNote, windowSpan } from '@/lib/schedule/bookingWindow';
import { waitlistJoinedCopy } from '@/lib/schedule/cancelCopy';
import { dayRange, gymClock12, gymParts, shiftDay } from '@/lib/schedule/gymClock';
import { longDay, shortDay } from '@/lib/schedule/labels';
import { isTimeFilter, matchesTime, type TimeFilter } from '@/lib/schedule/timeOfDay';
import { EmptyState } from '@/components/portal/ui';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CancelBookingDialog } from '@/components/schedule/CancelBookingDialog';
import { CoachCancelClassDialog, CoachClassSheet } from '@/components/schedule/CoachClassSheet';
import { DateStrip } from '@/components/schedule/DateStrip';
import { ScheduleFilters, type CoachOption } from '@/components/schedule/ScheduleFilters';
import { SessionCard } from '@/components/schedule/SessionCard';

/**
 * The timetable, and booking from it.
 *
 * One day at a time behind a date strip that is exactly the member's booking
 * window: 14 gym days, or 21 on a priority plan (owner, 2026-10-11), today
 * included. That is how a member decides: "what is on Thursday evening". Day,
 * time of day and coach live in the URL, so Back, refresh and a shared link
 * all land on the same view.
 *
 * The member's own bookings decide every card's state through bookingState(),
 * and ANY non-cancelled row — including one the register already marked —
 * means Book is never offered again for that class.
 *
 * The window comes from `GET /me/booking-window`, which also says whether the
 * member's plan lets them book at all. A refusal is explained BEFORE they tap
 * Book (the banner, the coverage note), but the server still checks every
 * booking on the class's own day. When it refuses, the page reloads, because a
 * refusal means what was on screen was out of date.
 */
export default function SchedulePage() {
  return (
    <Suspense fallback={<ScheduleSkeleton />}>
      <Schedule />
    </Suspense>
  );
}

function ScheduleSkeleton() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-6 w-56" />
      <Skeleton className="h-[72px] w-full" />
      <Skeleton className="h-9 w-80" />
      <Skeleton className="h-[120px] w-full" />
      <Skeleton className="h-[120px] w-full" />
    </div>
  );
}

function Schedule() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const [now, setNow] = useState(() => new Date());
  const today = gymParts(now).date;

  // Named `ahead`, not `window`, so it never shadows the browser global.
  const [ahead, setAhead] = useState<MyBookingWindow | null>(null);
  // The last window the server DID answer with. A ref, not state, so that
  // `load` can read it without depending on it (it would reload itself).
  const lastWindow = useRef<MyBookingWindow | null>(null);
  // The standard fortnight until the server has said, or if it could not say.
  const windowDays = ahead?.windowDays ?? CLASS_BOOKING_WINDOW_DAYS;
  const days = useMemo(() => dayRange(today, windowDays), [today, windowDays]);

  const requestedDay = params.get('day');
  const day = requestedDay !== null && days.includes(requestedDay) ? requestedDay : today;
  const requestedTime = params.get('time');
  const time: TimeFilter = isTimeFilter(requestedTime) ? requestedTime : 'all';
  const coach = params.get('coach') ?? 'all';

  const setParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        const isDefault = value === 'all' || (key === 'day' && value === today);
        if (isDefault) next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [params, pathname, router, today],
  );

  const [sessions, setSessions] = useState<ClassSession[] | null>(null);
  const [bookings, setBookings] = useState<MyBooking[]>([]);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<MyBooking | null>(null);
  // Book and Cancel both need `booking.create` members hold it, staff and
  // coaches do not — so the timetable is read-only for everybody else rather
  // than offering buttons that fail with "Missing required permission". The
  // plan banner is a member's too: a coach has no plan and needs none.
  const canBook = usePermission(PERMISSIONS.BOOKING_CREATE);
  // The banner's "Renew" goes to My Subscription, which is CLIENT-only.
  const canSelfServe = usePermission(PERMISSIONS.MEMBERSHIP_SELF);
  // Coaches run their own classes (owner, 2026-10-23): `class.manage`, which
  // COACH holds at OWN. The page offers New class, and Edit / Cancel class on
  // classes the caller coaches; the server refuses anybody else's. ONLY at OWN:
  // an admin holds it at ALL, runs classes from the CRM, and is not a coach, so
  // "New class" with themselves as coach would only fail here.
  const holdsClassManage = usePermission(PERMISSIONS.CLASS_MANAGE);
  const holdsClassManageAll = usePermission(PERMISSIONS.CLASS_MANAGE, { scope: 'ALL' });
  const canManageClasses = holdsClassManage && !holdsClassManageAll;
  const { me } = useMe();
  const meId = canManageClasses ? (me?.id ?? null) : null;
  /** `undefined` closed · `null` a new class · a class to edit. */
  const [composing, setComposing] = useState<ClassSession | null | undefined>(undefined);
  const [cancellingClass, setCancellingClass] = useState<ClassSession | null>(null);
  const [classBusy, setClassBusy] = useState(false);
  const [classError, setClassError] = useState<string | null>(null);

  /**
   * The window first, then the timetable over exactly the days the strip
   * shows. That is two round trips rather than one, because how far ahead to
   * fetch IS the window. Losing the window is not fatal: the strip keeps the
   * last window the server gave, or falls back to the standard fortnight when
   * it never gave one, and the server still checks every booking. Falling
   * back to 14 on a blip after a booking would shrink a priority member's
   * 21-day strip and throw them back to today.
   */
  const load = useCallback(async (): Promise<void> => {
    const fetched = await classesApi.bookingWindow().catch(() => null);
    if (fetched !== null) lastWindow.current = fetched;
    const nextWindow = fetched ?? lastWindow.current;
    const span = nextWindow?.windowDays ?? CLASS_BOOKING_WINDOW_DAYS;
    const [list, mine] = await Promise.all([
      classesApi.sessions({ from: today, to: shiftDay(today, span - 1) }),
      // A day either side, so a class that started a moment ago still knows it is mine.
      classesApi.myBookings({ from: shiftDay(today, -1), to: shiftDay(today, span) }),
    ]);
    setAhead(nextWindow);
    setSessions(list);
    setBookings(mine);
    setNow(new Date());
  }, [today]);

  useEffect(() => {
    load().catch(() => setFailed(true));
  }, [load]);

  // After a book or a cancel. A refresh that fails keeps what is on screen: the
  // toast has already said what happened, and blanking the whole timetable over
  // a dropped connection would only lose the member's place in it.
  const refresh = (): Promise<void> => load().catch(() => undefined);

  const bookingFor = (sessionId: string): MyBooking | undefined =>
    bookings.find((item) => item.session.id === sessionId && holdsPlace(item));

  const markedDays = useMemo(
    () => new Set(bookings.filter(holdsPlace).map((item) => item.session.businessDate)),
    [bookings],
  );

  const liveCount = bookings.filter((item) => bookingState(item, now).live).length;

  const coaches = useMemo<CoachOption[]>(() => {
    const byId = new Map<string, string>();
    for (const item of sessions ?? []) byId.set(item.coachId, item.coachName);
    return [...byId]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions]);

  const visible = (sessions ?? [])
    .filter(
      (item) =>
        item.businessDate === day &&
        matchesTime(item.startsAt, time) &&
        (coach === 'all' || item.coachId === coach),
    )
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  /** Book, Join waitlist and Take the free place are all this one POST. */
  const book = async (session: ClassSession): Promise<void> => {
    setBusyId(session.id);
    try {
      const result = await classesApi.book(session.id);
      if (result.status === 'WAITLISTED') {
        const copy = waitlistJoinedCopy(result, new Date());
        toast.success(copy.title, { description: copy.description });
      } else {
        toast.success(
          `Booked — ${session.title}, ${shortDay(session.businessDate)} ${gymClock12(session.startsAt)}`,
        );
      }
      await refresh();
    } catch (caught) {
      // The server's own words: BOOKING_PLAN_REQUIRED, BOOKING_WINDOW_NOT_OPEN
      // and WAITLIST_CLOSED are member copy by design.
      toast.error(bookingErrorMessage(caught));
      if (isBookingRefusal(caught)) await refresh();
    } finally {
      setBusyId(null);
    }
  };

  /**
   * Opens the cancel dialog on a fresh clock. What it says happens to the
   * freed place depends on the time (the queue before the waitlist cutoff,
   * whoever books first after it), and `now` is from the last load: a member
   * who opened the timetable at 15:50 and taps Cancel at 16:10 must read the
   * 16:10 sentence.
   */
  const openCancel = (target: MyBooking): void => {
    setNow(new Date());
    setCancelling(target);
  };

  const confirmCancel = async (target: MyBooking): Promise<void> => {
    setBusyId(target.session.id);
    try {
      await classesApi.cancel(target.session.id);
      toast.success(
        target.status === 'WAITLISTED'
          ? 'You have left the waitlist.'
          : 'Cancelled — your place has been released.',
      );
      setCancelling(null);
      await refresh();
    } catch (caught) {
      toast.error(bookingErrorMessage(caught));
      if (isBookingRefusal(caught)) {
        setCancelling(null);
        await refresh();
      }
    } finally {
      setBusyId(null);
    }
  };

  /** The server's own sentence for a refused class write — they are written for people. */
  const classFailure = (caught: unknown): string =>
    caught instanceof ApiError ? caught.message : 'That did not save. Try again.';

  const saveClass = async (draft: ClassDraft): Promise<void> => {
    if (meId === null || composing === undefined) return;
    setClassBusy(true);
    setClassError(null);
    try {
      if (composing === null) {
        const created = await adminApi.createClassSession(createBody(draft, meId));
        toast.success(`${created.title} is on the timetable.`);
      } else {
        const patch = patchFor(composing, draft);
        // Nothing changed: close without a request, which would still tell
        // everybody booked that the class "changed".
        if (Object.keys(patch).length > 0) {
          await adminApi.updateClassSession(composing.id, patch);
          toast.success('Class updated.');
        }
      }
      setComposing(undefined);
      await refresh();
    } catch (caught) {
      setClassError(classFailure(caught));
    } finally {
      setClassBusy(false);
    }
  };

  const cancelClass = async (target: ClassSession, reason: string): Promise<void> => {
    setClassBusy(true);
    setClassError(null);
    try {
      await adminApi.cancelClassSession(target.id, reason);
      toast.success(`${target.title} is cancelled. Everybody booked has been told.`);
      setCancellingClass(null);
      await refresh();
    } catch (caught) {
      setClassError(classFailure(caught));
    } finally {
      setClassBusy(false);
    }
  };

  if (failed) {
    return (
      <EmptyState title="Could not load the timetable" hint="Check your connection and refresh." />
    );
  }
  if (sessions === null) return <ScheduleSkeleton />;

  const coachName = coaches.find((option) => option.id === coach)?.name;
  const filtered = time !== 'all' || coach !== 'all';
  const banner = canBook ? windowBanner(ahead) : null;
  const coverage = canBook ? windowCoverageNote(ahead, today) : null;

  return (
    <div className="grid gap-4">
      {banner === null ? null : (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-warn/30 bg-warn-bg px-4 py-3">
          <p className="m-0 max-w-[62ch] text-sm text-foreground">{banner.message}</p>
          {banner.action !== null && canSelfServe ? (
            <Link
              href={banner.action.href}
              className="font-display text-sm font-semibold text-gold-deep hover:underline"
            >
              {banner.action.label} →
            </Link>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-display text-base font-semibold">{longDay(day)}</h2>
        {meId === null ? (
          <Link
            href="/portal/book"
            className="font-display text-sm font-semibold text-gold-deep hover:underline"
          >
            My bookings · {liveCount} →
          </Link>
        ) : (
          // A coach has no bookings of their own; they have classes to run.
          <Button
            size="sm"
            onClick={() => {
              setClassError(null);
              setComposing(null);
            }}
          >
            New class
          </Button>
        )}
      </div>

      <div className="grid gap-1">
        <DateStrip
          days={days}
          today={today}
          selected={day}
          markedDays={markedDays}
          onSelect={(value) => setParams({ day: value })}
        />
        {coverage === null ? null : <p className="m-0 text-[12.5px] text-ink-3">{coverage}</p>}
      </div>

      <ScheduleFilters
        time={time}
        coach={coach}
        coaches={coaches}
        onTime={(value) => setParams({ time: value })}
        onCoach={(value) => setParams({ coach: value })}
      />

      {visible.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl bg-card px-5 py-8 text-center">
          <p className="font-display text-[15px] font-semibold">
            {filtered ? 'No classes match' : 'Nothing on this day'}
          </p>
          <p className="max-w-[46ch] text-sm text-ink-3">
            {filtered
              ? `Nothing ${time === 'all' ? '' : `${time} `}on ${longDay(day)}${coachName ? ` with ${coachName}` : ''}.`
              : `Try another day — the strip above covers the next ${windowSpan(windowDays)}.`}
          </p>
          {filtered ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setParams({ time: 'all', coach: 'all' })}
            >
              Clear filters
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-3">
          {visible.map((item) => (
            <SessionCard
              key={item.id}
              session={item}
              booking={bookingFor(item.id)}
              now={now}
              busy={busyId === item.id}
              onBook={canBook ? (target) => void book(target) : undefined}
              onCancel={canBook ? openCancel : undefined}
              onEdit={
                canEditClass(item, meId, now)
                  ? (target) => {
                      setClassError(null);
                      setComposing(target);
                    }
                  : undefined
              }
              onCancelClass={
                canCancelClass(item, meId, now)
                  ? (target) => {
                      setClassError(null);
                      setCancellingClass(target);
                    }
                  : undefined
              }
            />
          ))}
        </div>
      )}

      {meId === null ? null : (
        <>
          <CoachClassSheet
            open={composing !== undefined}
            session={composing ?? null}
            day={day}
            coachName={me === null ? 'You' : `${me.firstName} ${me.lastName}`.trim()}
            busy={classBusy}
            error={classError}
            onSave={(draft) => void saveClass(draft)}
            onClose={() => setComposing(undefined)}
          />
          <CoachCancelClassDialog
            session={cancellingClass}
            busy={classBusy}
            error={classError}
            onConfirm={(target, reason) => void cancelClass(target, reason)}
            onClose={() => setCancellingClass(null)}
          />
        </>
      )}

      <CancelBookingDialog
        booking={cancelling}
        now={now}
        busy={busyId !== null}
        onConfirm={(target) => void confirmCancel(target)}
        onClose={() => setCancelling(null)}
      />
    </div>
  );
}
