import { describe, expect, it } from 'vitest';
import { DenialReason, bookingRefusalCopy, type MyBookingWindowWire } from '@got/shared';
import { windowBanner, windowCoverageNote, windowSpan } from './bookingWindow';

/** Sun 11 Oct 2026, a standard plan in good standing to the end of its window. */
function ahead(over: Partial<MyBookingWindowWire> = {}): MyBookingWindowWire {
  return {
    windowDays: 14,
    lastBookableDay: '2026-10-24',
    eligibleToday: true,
    reason: null,
    message: null,
    planCoversUntil: '2026-11-04',
    ...over,
  };
}

function refused(
  reason: DenialReason,
  over: Partial<MyBookingWindowWire> = {},
): MyBookingWindowWire {
  return ahead({
    eligibleToday: false,
    reason,
    message: bookingRefusalCopy(reason, null),
    ...over,
  });
}

const SUBSCRIPTION = '/portal/subscription';

describe('windowBanner', () => {
  it('says nothing while the member may book, or before the server has answered', () => {
    expect(windowBanner(null)).toBeNull();
    expect(windowBanner(ahead())).toBeNull();
  });

  it("shows the server's member copy verbatim, with the way to fix it", () => {
    expect(windowBanner(refused(DenialReason.NO_MEMBERSHIP, { planCoversUntil: null }))).toEqual({
      message:
        'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
      action: { label: 'Choose a plan', href: SUBSCRIPTION },
    });
  });

  /** The same buttons the dashboard's status band offers for these reasons. */
  it('offers the Subscription page for every plan reason', () => {
    expect(windowBanner(refused(DenialReason.MEMBERSHIP_EXPIRED))?.action).toEqual({
      label: 'Renew',
      href: SUBSCRIPTION,
    });
    expect(windowBanner(refused(DenialReason.MEMBERSHIP_CANCELLED))?.action).toEqual({
      label: 'Choose a plan',
      href: SUBSCRIPTION,
    });
    expect(windowBanner(refused(DenialReason.MEMBERSHIP_FROZEN))?.action).toEqual({
      label: 'View my plan',
      href: SUBSCRIPTION,
    });
  });

  /** An account note is vague on purpose, and the Subscription page cannot lift it. */
  it('offers no link for an account note', () => {
    expect(windowBanner(refused(DenialReason.ACCOUNT_SUSPENDED))).toEqual({
      message: "There's a note on your account. Please talk to the desk.",
      action: null,
    });
    expect(windowBanner(refused(DenialReason.ACCOUNT_DEACTIVATED))?.action).toBeNull();
  });

  it('falls back to the shared copy when the server sent a reason without a message', () => {
    expect(windowBanner(refused(DenialReason.MEMBERSHIP_EXPIRED, { message: null }))?.message).toBe(
      'Your plan has ended. Renew to book classes.',
    );
  });

  it('says nothing it cannot source', () => {
    expect(windowBanner(ahead({ eligibleToday: false }))).toBeNull();
  });
});

describe('windowCoverageNote', () => {
  const today = '2026-10-11';

  it('notes a plan that ends inside the window', () => {
    expect(windowCoverageNote(ahead({ planCoversUntil: '2026-10-20' }), today)).toBe(
      'Your plan covers classes up to Tue 20 Oct. Classes after that need a renewal.',
    );
  });

  it('is quiet when the plan covers the whole window, to its last day', () => {
    expect(windowCoverageNote(ahead({ planCoversUntil: '2026-10-24' }), today)).toBeNull();
    expect(windowCoverageNote(ahead(), today)).toBeNull();
  });

  it('is quiet without a plan, or once it has ended — the banner says that', () => {
    expect(windowCoverageNote(null, today)).toBeNull();
    expect(windowCoverageNote(ahead({ planCoversUntil: null }), today)).toBeNull();
    expect(windowCoverageNote(ahead({ planCoversUntil: '2026-10-10' }), today)).toBeNull();
  });

  it('still notes a plan whose last day is today', () => {
    expect(windowCoverageNote(ahead({ planCoversUntil: today }), today)).toBe(
      'Your plan covers classes up to Sun 11 Oct. Classes after that need a renewal.',
    );
  });
});

describe('windowSpan', () => {
  it('says the standard and the priority window in weeks', () => {
    expect(windowSpan(14)).toBe('two weeks');
    expect(windowSpan(21)).toBe('three weeks');
    expect(windowSpan(7)).toBe('week');
  });

  it('falls back to days for anything else', () => {
    expect(windowSpan(10)).toBe('10 days');
    expect(windowSpan(35)).toBe('35 days');
  });
});
