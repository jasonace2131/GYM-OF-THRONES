'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { CLASS_BOOKING_WINDOW_DAYS } from '@got/shared';
import { classesApi, type MyBooking } from '@/lib/classes';
import { useIsPhone } from '@/lib/useMediaQuery';
import { bookingErrorMessage, isBookingRefusal } from '@/lib/schedule/bookingErrors';
import { bookingState, dayMarks } from '@/lib/schedule/bookingState';
import { dayRange, gymClock12, gymParts, mondayOf, shiftDay } from '@/lib/schedule/gymClock';
import { groupBookings } from '@/lib/schedule/groupBookings';
import { longDay, shortDay } from '@/lib/schedule/labels';
import { EmptyState } from '@/components/portal/ui';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BookingDetailSheet } from '@/components/schedule/BookingDetailSheet';
import { CancelBookingDialog } from '@/components/schedule/CancelBookingDialog';
import { DayAgenda } from '@/components/schedule/DayAgenda';
import { MonthCalendar } from '@/components/schedule/MonthCalendar';
import { WeekTimeGrid, type BlockTone } from '@/components/schedule/WeekTimeGrid';

type View = 'month' | 'week' | 'list';

const DOT_TONE: Record<string, BlockTone> = {
  booked: 'booked',
  waitlist: 'waitlist',
  attended: 'attended',
  other: 'other',
};

/**
 * The member's own classes, three ways.
 *
 * Month answers "which days am I in this month"; Week answers "what does my
 * week look like hour by hour"; List answers "what is on now, what's next,
 * and what is done". All three read the same bookings through bookingState(),
 * so a class can never be Booked in one view and Attended in another.
 */
export default function MyBookingsPage() {
  return (
    <Suspense fallback={<BookingsSkeleton />}>
      <MyBookings />
    </Suspense>
  );
}

function BookingsSkeleton() {
  return (
    <div className="grid gap-3">
      <Skeleton className="h-9 w-60" />
      <Skeleton className="h-[340px] w-full" />
    </div>
  );
}

function MyBookings() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const isPhone = useIsPhone();

  const [now, setNow] = useState(() => new Date());
  const today = gymParts(now).date;

  const requestedView = params.get('view');
  const view: View = requestedView === 'week' || requestedView === 'list' ? requestedView : 'month';
  const requestedDate = params.get('date');
  const date =
    requestedDate !== null && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : today;

  const setParams = useCallback(
    (updates: Record<string, string>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(updates)) {
        const isDefault =
          (key === 'view' && value === 'month') || (key === 'date' && value === today);
        if (isDefault) next.delete(key);
        else next.set(key, value);
      }
      const query = next.toString();
      router.replace(query === '' ? pathname : `${pathname}?${query}`, { scroll: false });
    },
    [params, pathname, router, today],
  );

  // What is on screen decides what is fetched.
  const weekLength = isPhone ? 3 : 7;
  const weekFirst = isPhone ? date : mondayOf(date);
  // Named `range`, not `window`, so it never shadows the browser global.
  const range = useMemo((): { from?: string; to?: string } => {
    if (view === 'month') {
      const gridStart = mondayOf(`${date.slice(0, 7)}-01`);
      return { from: gridStart, to: shiftDay(gridStart, 41) };
    }
    if (view === 'week') return { from: weekFirst, to: shiftDay(weekFirst, weekLength - 1) };
    return {};
  }, [view, date, weekFirst, weekLength]);

  const [bookings, setBookings] = useState<MyBooking[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [detail, setDetail] = useState<MyBooking | null>(null);
  const [cancelling, setCancelling] = useState<MyBooking | null>(null);
  /**
   * How far ahead this member may book (14 gym days, or 21 on a priority
   * plan), so that "See classes on …" is offered for exactly the days the
   * timetable's strip shows. The standard fortnight until the server says.
   */
  const [windowDays, setWindowDays] = useState(CLASS_BOOKING_WINDOW_DAYS);

  useEffect(() => {
    let current = true;
    classesApi
      .bookingWindow()
      .then((ahead) => {
        if (current) setWindowDays(ahead.windowDays);
      })
      // Not fatal: the link falls back to the standard window, and the
      // timetable decides for itself anyway.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    setBookings(await classesApi.myBookings(range));
    setNow(new Date());
  }, [range]);

  useEffect(() => {
    load().catch(() => setFailed(true));
  }, [load]);

  /**
   * Opens the cancel dialog on a fresh clock. What it says happens to the
   * freed place depends on the time (the queue before the waitlist cutoff,
   * whoever books first after it), and `now` is from the last load: a page
   * left open across the cutoff must not promise the next person in the queue
   * a seat that will go to whoever books first.
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
      setDetail(null);
      // A refresh that fails keeps the list on screen; the toast said it all.
      await load().catch(() => undefined);
    } catch (caught) {
      toast.error(bookingErrorMessage(caught));
      // Refused (the class started, the gym cancelled it): what is on screen
      // was out of date, so close the dialog and show what is true now.
      if (isBookingRefusal(caught)) {
        setCancelling(null);
        setDetail(null);
        await load().catch(() => undefined);
      }
    } finally {
      setBusyId(null);
    }
  };

  if (failed) {
    return (
      <EmptyState title="Could not load your bookings" hint="Check your connection and refresh." />
    );
  }

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Tabs value={view} onValueChange={(value) => setParams({ view: value })}>
        <TabsList>
          <TabsTrigger value="month" className="font-display">
            Month
          </TabsTrigger>
          <TabsTrigger value="week" className="font-display">
            Week
          </TabsTrigger>
          <TabsTrigger value="list" className="font-display">
            List
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <Link
        href="/portal/schedule"
        className="font-display text-sm font-semibold text-gold-deep hover:underline"
      >
        Book a class →
      </Link>
    </div>
  );

  const dialogs = (
    <>
      <BookingDetailSheet
        booking={detail}
        now={now}
        side={isPhone ? 'bottom' : 'right'}
        onClose={() => setDetail(null)}
        onCancel={openCancel}
      />
      <CancelBookingDialog
        booking={cancelling}
        now={now}
        busy={busyId !== null}
        onConfirm={(target) => void confirmCancel(target)}
        onClose={() => setCancelling(null)}
      />
    </>
  );

  if (bookings === null) {
    return (
      <div className="grid gap-4">
        {header}
        <BookingsSkeleton />
      </div>
    );
  }

  if (view === 'month') {
    const dayBookings = bookings
      .filter((item) => item.session.businessDate === date)
      .sort((a, b) => a.session.startsAt.localeCompare(b.session.startsAt));
    // The days the timetable's strip shows: today to today + (window − 1).
    const bookable = date >= today && date <= shiftDay(today, windowDays - 1);

    return (
      <div className="grid gap-4">
        {header}
        <div className="grid items-start gap-4 min-[900px]:grid-cols-[380px_minmax(0,1fr)]">
          <MonthCalendar
            selected={date}
            month={`${date.slice(0, 7)}-01`}
            marks={dayMarks(bookings, now)}
            onSelect={(value) => setParams({ date: value })}
            onMonthChange={(first) => setParams({ date: first })}
          />
          <DayAgenda
            title={longDay(date)}
            bookings={dayBookings}
            now={now}
            busyId={busyId}
            onCancel={openCancel}
            onOpen={setDetail}
            empty={
              <>
                <span className="font-display text-[15px] font-semibold text-foreground">
                  No classes this day
                </span>
                {bookable ? (
                  <Link
                    href={`/portal/schedule?day=${date}`}
                    className="text-gold-deep hover:underline"
                  >
                    See classes on {shortDay(date)}
                  </Link>
                ) : (
                  <span>Pick a day with a dot to see what you booked.</span>
                )}
              </>
            }
          />
        </div>
        {dialogs}
      </div>
    );
  }

  if (view === 'week') {
    const days = dayRange(weekFirst, weekLength);
    const events = bookings.map((item) => ({
      id: item.bookingId,
      startsAt: item.session.startsAt,
      endsAt: item.session.endsAt,
      booking: item,
    }));

    return (
      <div className="grid gap-4">
        {header}
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-display text-base font-semibold">
            {shortDay(days[0] as string)} – {shortDay(days[days.length - 1] as string)}
          </h2>
          <div className="flex gap-1.5">
            <Button
              variant="outline"
              size="icon"
              aria-label="Earlier"
              onClick={() => setParams({ date: shiftDay(weekFirst, -weekLength) })}
            >
              ‹
            </Button>
            <Button variant="outline" size="sm" onClick={() => setParams({ date: today })}>
              Today
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="Later"
              onClick={() => setParams({ date: shiftDay(weekFirst, weekLength) })}
            >
              ›
            </Button>
          </div>
        </div>
        <WeekTimeGrid
          days={days}
          today={today}
          now={now}
          events={events}
          hourHeight={isPhone ? 40 : 44}
          describe={(event) => {
            const state = bookingState(event.booking, now);
            const tone: BlockTone =
              event.booking.session.cancelledAt !== null
                ? 'cancelled'
                : (DOT_TONE[state.dot] ?? 'other');
            return {
              title: event.booking.session.title,
              detail: `${gymClock12(event.startsAt)} · ${state.label}`,
              tone,
              label: `${event.booking.session.title}, ${shortDay(event.booking.session.businessDate)} ${gymClock12(event.startsAt)}, ${state.label}`,
            };
          }}
          onSelect={(event) => setDetail(event.booking)}
        />
        <p className="text-xs text-ink-3">
          {isPhone ? 'Three days at a time; the arrows move by three.' : 'Monday to Sunday.'} The
          red line is now, in gym time.
        </p>
        {dialogs}
      </div>
    );
  }

  // By time alone; each row's badge says what became of it (`groupBookings`).
  const { onNow, comingUp, past } = groupBookings(bookings, now);

  return (
    <div className="grid gap-4">
      {header}
      {onNow.length === 0 ? null : (
        <DayAgenda
          title="On now"
          bookings={onNow}
          now={now}
          busyId={busyId}
          onCancel={openCancel}
          onOpen={setDetail}
        />
      )}
      <DayAgenda
        title="Coming up"
        bookings={comingUp}
        now={now}
        busyId={busyId}
        onCancel={openCancel}
        onOpen={setDetail}
        showDate
        empty={
          <>
            <span className="font-display text-[15px] font-semibold text-foreground">
              Nothing coming up
            </span>
            <Link href="/portal/schedule" className="text-gold-deep hover:underline">
              See what is on
            </Link>
          </>
        }
      />
      <DayAgenda
        title="Past"
        bookings={past}
        now={now}
        busyId={busyId}
        onCancel={openCancel}
        onOpen={setDetail}
        showDate
        empty={<span>Classes appear here once they have finished.</span>}
      />
      {dialogs}
    </div>
  );
}
