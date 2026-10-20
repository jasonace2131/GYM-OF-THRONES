import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AccessVerdict, type CheckInResult, type CivilDate } from '@got/shared';
import { CheckInVerdict } from './CheckInVerdict';

/**
 * The card's buttons, asserted on rendered markup (react-dom/server, like
 * SessionCard.test.tsx). A second scan never checks anyone out by itself
 * (owner, 2026-10-20): it offers Check out and Stay checked in, and only on
 * the member's own station scan.
 */

const noop = (): void => undefined;

function result(over: Partial<CheckInResult> = {}): CheckInResult {
  return {
    outcome: 'ALREADY_INSIDE',
    replayed: false,
    display: {
      tone: 'WELCOME',
      headline: "You're already in.",
      subhead: 'Since 3:05 PM.',
      detail: 'Leaving? Check out below.',
    },
    checkIn: {
      id: 'c0000000-0000-4000-8000-000000000001',
      occurredAt: '2026-09-25T07:05:00.000Z',
      businessDate: '2026-09-25' as CivilDate,
      verdict: AccessVerdict.ALLOWED,
      visitNumberThisMonth: 4,
    },
    session: null,
    denial: null,
    checkOutOffered: true,
    nextStep: null,
    membership: {
      planName: null,
      status: null,
      endsOn: null,
      daysRemaining: null,
      decision: 'ALLOW',
    },
    station: { code: '9F2K', name: 'Front desk' },
    serverTime: '2026-09-25T08:00:00.000Z',
    ...over,
  };
}

const render = (r: CheckInResult, checkingOut = false): string =>
  renderToStaticMarkup(
    <CheckInVerdict result={r} onScanAgain={noop} onCheckOut={noop} checkingOut={checkingOut} />,
  );

/** The opening tag of the button whose text is `label`. */
const buttonTag = (html: string, label: string): string => {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[0];
};

describe('CheckInVerdict', () => {
  it('offers a gold Check out and a ghost Stay checked in when already inside', () => {
    const html = render(result());
    expect(buttonTag(html, 'Check out')).toContain('p-btn-gold');
    expect(buttonTag(html, 'Stay checked in')).toContain('p-btn-ghost');
    expect(html).not.toContain('Scan again');
    // Check out comes first.
    expect(html.indexOf('Check out<')).toBeLessThan(html.indexOf('Stay checked in'));
  });

  it('disables both buttons and says so while the check-out is in flight', () => {
    const html = render(result(), true);
    expect(buttonTag(html, 'Checking out…')).toContain('disabled');
    expect(buttonTag(html, 'Stay checked in')).toContain('disabled');
  });

  it('offers no check-out when the server did not — a desk entry or an expired code', () => {
    // The station is still there on an expired code; only the flag decides.
    const html = render(
      result({ checkOutOffered: false, display: { ...result().display, detail: null } }),
    );
    expect(html).not.toContain('>Check out<');
    expect(html).not.toContain('Stay checked in');
    expect(html).toContain('Scan again');
  });

  it('offers no check-out on a replayed snapshot from before the flag existed', () => {
    const legacy = { ...result() } as Partial<CheckInResult>;
    delete legacy.checkOutOffered;
    const html = render(legacy as CheckInResult);
    expect(html).not.toContain('>Check out<');
  });

  it('shows Check in again on the checked-out card', () => {
    const html = render(
      result({
        outcome: 'CHECKED_OUT',
        checkOutOffered: false,
        display: {
          tone: 'GOODBYE',
          headline: 'Checked out.',
          subhead: '55 m today.',
          detail: null,
        },
        session: {
          startedAt: '2026-09-25T07:05:00.000Z',
          endedAt: '2026-09-25T08:00:00.000Z',
          durationMinutes: 55,
        },
      }),
    );
    expect(html).toContain('Checked out.');
    expect(buttonTag(html, 'Check in again')).toContain('p-btn-ghost');
    expect(html).not.toContain('Stay checked in');
  });

  it('keeps Scan again on a fresh check-in', () => {
    const html = render(
      result({
        outcome: 'CHECKED_IN',
        checkOutOffered: false,
        display: { tone: 'WELCOME', headline: "You're in.", subhead: 'Juan', detail: null },
      }),
    );
    expect(html).toContain('Scan again');
    expect(html).not.toContain('>Check out<');
  });
});
