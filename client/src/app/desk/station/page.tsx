'use client';

import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { StationTokenBatch } from '@got/shared';
import { StationQr } from '@/components/desk/StationQr';
import {
  activeToken,
  anchorFrom,
  correctedNow,
  deskClock,
  displayState,
  formatOutage,
  headPollMs,
  pastOpenUntil,
  shouldRefill,
  type ClockAnchor,
  type DisplayState,
} from '@/lib/stationDisplay';
import {
  fetchStationBatch,
  forgetStationCredential,
  isBatchStale,
  type StationFetchResult,
} from '@/lib/stationClient';
import { useStationCredential } from '@/lib/useStationCredential';
import {
  chooseStationCredential,
  staffLoginPath,
  stationCodeFor,
  stationModeFrom,
  type CredentialChoice,
  type StationMode,
} from '@/lib/stationAuth';
import { supabase } from '@/lib/supabase';

/**
 * `/desk/station` — the panel members scan.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ONE RULE: NEVER PAINT A CODE THIS DISPLAY CANNOT PROVE IS IN WINDOW.
 *
 * A code that scans and then fails is worse than showing nothing. It teaches
 * members the system is broken so they stop trying, and it manufactures a
 * queue of denials for a fault that is not theirs. Everything below serves
 * that rule:
 *
 *   - the rendered token comes from `activeToken`, which returns `null`
 *     rather than "the nearest one";
 *   - the clock is the SERVER's, re-anchored on every fetch, so a mounted
 *     tablet's drifting clock cannot pick the wrong slot;
 *   - the epoch head check runs every slot, so a `tokenEpoch` bump blanks
 *     this screen within thirty seconds instead of five minutes;
 *   - the batch is refilled at HALF its runway, so one failed request is
 *     never visible.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO MODES, ONE SCREEN. By default this is the lobby tablet, authenticated
 * by its own station key. `?mode=staff` is the console's "Show check-in QR":
 * the same display, authenticated by the signed-in staff member's session
 * (`checkin.station_token.issue`), so the front desk can put the code up on
 * any screen without an admin provisioning a tablet. Which credential is sent
 * is decided in `lib/stationAuth.ts`, never here. Unlike the tablet — which
 * must never bounce to a login page — the staff display sends an expired
 * session back to sign in, and says so plainly when an account may not show
 * the code at all.
 */

/** The wall clock repaints once a second. Members trust a clock. */
const CLOCK_TICK_MS = 1_000;
/** How often the refill timer wakes to ask whether a refill is due. */
const REFILL_CHECK_MS = 5_000;
/** Poll cadence while the gym is shut, so an unattended screen sleeps. */
const CLOSED_POLL_MS = 10 * 60_000;

const GYM_TIMEZONE = 'Asia/Manila';

interface Feed {
  batch: StationTokenBatch | null;
  anchor: ClockAnchor | null;
  settled: boolean;
  closed: boolean;
  nextOpensAt: string | null;
  revoked: boolean;
  /** Staff mode only: this account does not hold `checkin.station_token.issue`. */
  forbidden: boolean;
  /** The server's own words for the last failure, shown on the staff display. */
  lastError: string | null;
  outageSinceMs: number | null;
}

const INITIAL: Feed = {
  batch: null,
  anchor: null,
  settled: false,
  closed: false,
  nextOpensAt: null,
  revoked: false,
  forbidden: false,
  lastError: null,
  outageSinceMs: null,
};

/** The display's next state after one token request. */
function nextFeed(
  previous: Feed,
  result: Exclude<StationFetchResult, { kind: 'SESSION_EXPIRED' }>,
): Feed {
  switch (result.kind) {
    case 'OK':
      return {
        batch: result.batch,
        anchor: anchorFrom(result.batch, result.receivedAtMs),
        settled: true,
        closed: false,
        nextOpensAt: null,
        revoked: false,
        forbidden: false,
        lastError: null,
        outageSinceMs: null,
      };
    case 'CLOSED':
      return {
        ...previous,
        batch: null,
        settled: true,
        closed: true,
        nextOpensAt: result.nextOpensAt,
        outageSinceMs: null,
      };
    case 'REVOKED':
      return {
        ...previous,
        batch: null,
        settled: true,
        revoked: true,
        outageSinceMs: previous.outageSinceMs ?? Date.now(),
      };
    case 'FORBIDDEN':
      // Signing in again would change nothing, so no retry loop and no
      // outage timer — the screen says what the account is missing.
      return { ...previous, batch: null, settled: true, forbidden: true, outageSinceMs: null };
    case 'OFFLINE':
      return {
        ...previous,
        settled: true,
        lastError: result.message,
        outageSinceMs: previous.outageSinceMs ?? Date.now(),
      };
  }
}

/**
 * `useSearchParams` reads `?mode=`, and in a prerendered route that hook must
 * sit under a Suspense boundary or `next build` fails. The fallback is the
 * display's own booting screen, so nothing jumps when it resolves.
 */
export default function StationDisplayPage() {
  return (
    <Suspense
      fallback={
        <div className="st-screen" data-state="BOOTING">
          <BootingPanel />
        </div>
      }
    >
      <StationDisplay />
    </Suspense>
  );
}

function StationDisplay() {
  const params = useSearchParams();
  const router = useRouter();
  const mode: StationMode = stationModeFrom(params.get('mode'));
  const { credential, save } = useStationCredential();
  const [feed, setFeed] = useState<Feed>(INITIAL);
  const [tick, setTick] = useState(() => Date.now());

  const key = credential.key;
  const code = stationCodeFor({ mode, storedCode: credential.code, param: params.get('station') });
  // The staff display needs no provisioning — the login IS the credential.
  const configured = mode === 'staff' || key !== null;
  const now = correctedNow(feed.anchor, tick);

  /**
   * Which credential to send, decided fresh on every request. In staff mode
   * the session is read each time, so a token Supabase refreshed in the
   * background is the one sent rather than the one the page opened with.
   */
  const resolveCredential = useCallback(async (): Promise<CredentialChoice> => {
    const accessToken =
      mode === 'staff'
        ? ((await supabase.auth.getSession()).data.session?.access_token ?? null)
        : null;
    return chooseStationCredential({ mode, stationKey: key, accessToken });
  }, [mode, key]);

  const toLogin = useCallback((): void => {
    router.replace(staffLoginPath());
  }, [router]);

  // Not memoised: it is only ever called through `refillRef`, which the
  // effect below keeps pointing at the latest render's copy.
  const refill = async (): Promise<void> => {
    const choice = await resolveCredential();
    const result = choice.kind === 'SEND' ? await fetchStationBatch(choice.credential, code) : null;

    // A staff display with no session, or one whose session just expired,
    // goes back to sign in and returns here afterwards.
    if (choice.kind === 'SIGNED_OUT' || result?.kind === 'SESSION_EXPIRED') {
      toLogin();
      return;
    }
    if (result === null) return;

    setFeed((previous) => nextFeed(previous, result));
  };

  const feedRef = useRef(feed);
  const refillRef = useRef(refill);
  const resolveRef = useRef(resolveCredential);
  const stateRef = useRef<DisplayState>('BOOTING');

  // Every render: the timers below read these refs, never stale closures.
  useEffect(() => {
    feedRef.current = feed;
    refillRef.current = refill;
    resolveRef.current = resolveCredential;
  });

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!configured) return;

    let stopped = false;
    const run = (): void => {
      if (!stopped) void refillRef.current();
    };

    const kickoff = window.setTimeout(run, 0);
    const id = window.setInterval(() => {
      const current = feedRef.current;
      const corrected = correctedNow(current.anchor, Date.now());
      if (current.forbidden) return;
      if (current.closed || shouldRefill(current.batch, corrected)) run();
    }, REFILL_CHECK_MS);

    return () => {
      stopped = true;
      window.clearTimeout(kickoff);
      window.clearInterval(id);
    };
  }, [configured, mode, key, code]);

  const state: DisplayState = displayState({
    batch: feed.batch,
    nowMs: now,
    configured,
    settled: feed.settled,
    closed: feed.closed || pastOpenUntil(feed.batch, now),
  });

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const etag = feed.batch?.batchEtag ?? null;
  const slotSeconds = feed.batch?.slotSeconds ?? 30;

  useEffect(() => {
    if (!configured || etag === null) return;

    const id = window.setInterval(
      () => {
        void resolveRef
          .current()
          .then((choice) =>
            choice.kind === 'SEND' ? isBatchStale(choice.credential, code, etag) : false,
          )
          .then((stale) => {
            if (!stale) return;
            setFeed((previous) => ({ ...previous, batch: null }));
            void refillRef.current();
          });
      },
      headPollMs(stateRef.current, slotSeconds),
    );

    return () => window.clearInterval(id);
  }, [configured, code, etag, slotSeconds]);

  useEffect(() => {
    if (!configured || !feed.closed) return;
    const id = window.setInterval(() => void refillRef.current(), CLOSED_POLL_MS);
    return () => window.clearInterval(id);
  }, [configured, feed.closed]);

  useEffect(() => {
    if (state === 'CLOSED' || state === 'UNCONFIGURED') return;

    let lock: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        lock = (await navigator.wakeLock?.request('screen')) ?? null;
        if (cancelled) void lock?.release();
      } catch {
        // Unsupported or denied.
      }
    };

    void acquire();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release();
    };
  }, [state]);

  if (state === 'UNCONFIGURED') return <SetupPanel onSave={save} />;

  const clock = deskClock(now, GYM_TIMEZONE);
  const token = activeToken(feed.batch, now);

  return (
    <div className="st-screen" data-state={state}>
      <header>
        <div className="st-brand">GYM OF THRONES</div>
        <div className="st-brand-sub">House of Fitness</div>
      </header>

      {feed.forbidden ? (
        <ForbiddenPanel />
      ) : state === 'LIVE' && token !== null ? (
        <LivePanel payload={token.payload} />
      ) : state === 'CLOSED' ? (
        <ClosedPanel nextOpensAt={feed.nextOpensAt} timeZone={GYM_TIMEZONE} mode={mode} />
      ) : state === 'BOOTING' ? (
        <BootingPanel />
      ) : (
        <FallbackPanel />
      )}

      <footer className="st-foot">
        <div>
          <div className="st-clock">
            <span className="st-dot" data-offline={feed.outageSinceMs !== null} aria-hidden />
            <span>
              {clock.time} · {clock.date}
            </span>
          </div>
          <div className="st-diag">{diagnosticLine({ state, feed, tick, code, mode })}</div>
        </div>

        <div className="st-aside">
          {state === 'LIVE' ? (
            <>
              No phone? Ask at the desk.
              <br />
              Wi-Fi: GOT-GUEST
            </>
          ) : (
            <>The desk can check you in.</>
          )}
        </div>
      </footer>
    </div>
  );
}

function LivePanel({ payload }: { payload: string }) {
  const [targetPx, setTargetPx] = useState(340);

  useEffect(() => {
    const measure = (): void =>
      setTargetPx(Math.floor(Math.min(window.innerWidth * 0.78, window.innerHeight * 0.46)));
    const id = window.setTimeout(measure, 0);
    window.addEventListener('resize', measure);
    return () => {
      window.clearTimeout(id);
      window.removeEventListener('resize', measure);
    };
  }, []);

  return (
    <div className="st-stage">
      <div className="st-card">
        <StationQr payload={payload} targetPx={targetPx} />
      </div>
      <div>
        <div className="st-headline">SCAN TO CHECK IN</div>
        <div className="st-sub">Open Gym of Thrones on your phone → Check in</div>
      </div>
    </div>
  );
}

function FallbackPanel() {
  return (
    <div className="st-stage">
      <div className="st-stripe" style={{ width: 'min(560px, 86vw)' }} aria-hidden />
      <div className="st-glyph" aria-hidden>
        ⚠
      </div>
      <div>
        <div className="st-headline">CHECK IN AT THE DESK</div>
        <div className="st-sub">
          Our network is down. The desk will check you in. Nothing is lost — your visit still
          counts.
        </div>
      </div>
      <div className="st-arrow" aria-hidden>
        →
      </div>
    </div>
  );
}

function BootingPanel() {
  return (
    <div className="st-stage">
      <div className="st-sub">Starting up…</div>
    </div>
  );
}

/** Staff mode, 403: this login may not put the code up. Retrying would not help. */
function ForbiddenPanel() {
  return (
    <div className="st-stage">
      <div className="st-headline">THIS ACCOUNT CAN&rsquo;T SHOW THE CHECK-IN CODE</div>
      <div className="st-sub">
        Showing the code needs the front-desk permission to issue station codes. Ask an admin, or
        use the lobby tablet.
      </div>
    </div>
  );
}

function ClosedPanel({
  nextOpensAt,
  timeZone,
  mode,
}: {
  nextOpensAt: string | null;
  timeZone: string;
  mode: StationMode;
}) {
  const opens =
    nextOpensAt === null
      ? null
      : new Intl.DateTimeFormat('en-US', {
          timeZone,
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(new Date(nextOpensAt));

  return (
    <div className="st-stage">
      <div className="st-headline">{opens === null ? 'CLOSED' : `CLOSED — opens ${opens}`}</div>
      {mode === 'staff' ? (
        // The staff member opened this on purpose and needs to know it is not
        // broken: codes are only minted during opening hours, by design.
        <div className="st-sub">
          Check-in codes are only issued while the gym is open. Leave this screen up — the code
          appears by itself when the gym opens. Members already inside can still be checked in at
          the desk.
        </div>
      ) : null}
    </div>
  );
}

function diagnosticLine(input: {
  state: DisplayState;
  feed: Feed;
  tick: number;
  code: string | null;
  mode: StationMode;
}): string {
  if (input.feed.revoked) return 'STATION NOT AUTHORISED — re-provision this tablet';
  if (input.feed.forbidden) return 'staff display · missing checkin.station_token.issue';

  const parts: string[] = [];
  if (input.mode === 'staff') parts.push('staff display');
  const stationCode = input.feed.batch?.station.code ?? input.code;
  if (stationCode !== null) parts.push(`station ${stationCode}`);

  if (input.feed.outageSinceMs !== null) {
    parts.push(`offline ${formatOutage(input.tick - input.feed.outageSinceMs)} · retrying`);
    // The staff display is read by the person who can fix it, so it carries
    // the server's reason ("More than one active station exists…").
    if (input.mode === 'staff' && input.feed.lastError !== null) parts.push(input.feed.lastError);
  } else if (input.state === 'LIVE' && input.feed.batch !== null) {
    parts.push(`epoch ${input.feed.batch.tokenEpoch}`);
  }

  return parts.join(' · ');
}

/**
 * First-run provisioning — a guided 2-step wizard.
 *
 * Step 1 tells staff exactly where to get the key so they never need
 * external documentation. Step 2 is the paste-and-start form.
 */
function SetupPanel({ onSave }: { onSave: (key: string, code: string) => void }) {
  const [step, setStep] = useState<1 | 2>(1);
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);

  const adminUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/admin/stations`
      : '/admin/stations';

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (value.trim().length === 0) {
      setError('Paste the station key before continuing.');
      return;
    }
    setError(null);
    onSave(value.trim(), code.trim().toUpperCase());
  };

  return (
    <div className="st-screen" data-state="UNCONFIGURED">
      <header>
        <div className="st-brand">GYM OF THRONES</div>
        <div className="st-brand-sub">Station setup</div>
      </header>

      <div className="st-stage">
        <div style={{ width: '100%', maxWidth: 460 }}>

          {/* ── Step progress indicator ── */}
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 32 }}>
            {[1, 2, 3].map((n, i) => (
              <div key={n} style={{ display: 'flex', alignItems: 'center', flex: i < 2 ? 1 : 'none' }}>
                <div
                  style={{
                    width: 28, height: 28, borderRadius: '50%',
                    display: 'grid', placeItems: 'center',
                    fontSize: 12, fontWeight: 700, flex: 'none',
                    background: step >= n ? 'var(--d-gold, #c9922a)' : 'rgba(255,255,255,0.12)',
                    color: step >= n ? '#000' : 'rgba(255,255,255,0.35)',
                    transition: 'background 0.3s',
                  }}
                >
                  {n}
                </div>
                {i < 2 && (
                  <div
                    style={{
                      flex: 1, height: 2, margin: '0 4px',
                      background: step > n ? 'var(--d-gold, #c9922a)' : 'rgba(255,255,255,0.12)',
                      transition: 'background 0.3s',
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {step === 1 ? (
            /* ── Step 1: Explain where to get the key ── */
            <div style={{ display: 'grid', gap: 20 }}>
              <div>
                <div
                  style={{
                    fontSize: 22, fontWeight: 800,
                    fontFamily: 'var(--font-heading, sans-serif)',
                    letterSpacing: '-0.01em', marginBottom: 8,
                  }}
                >
                  GET YOUR STATION KEY
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--d-text-2, #999)' }}>
                  A station key is a one-time secret that lets this tablet display rotating
                  check-in codes. You create it from the admin panel on any other device.
                </div>
              </div>

              <ol style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 12 }}>
                {[
                  'Open the Admin panel in any browser — not this tablet.',
                  'Click Stations in the left sidebar.',
                  'Click "Provision a tablet" on the front desk station.',
                  'Copy the key that appears — it is shown ONCE and cannot be recovered.',
                ].map((text, i) => (
                  <li
                    key={i}
                    style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: 1.5, color: 'var(--d-text-2, #999)' }}
                  >
                    <span style={{ color: 'var(--d-gold, #c9922a)', fontWeight: 700, flex: 'none', minWidth: 18 }}>
                      {['①', '②', '③', '④'][i]}
                    </span>
                    {text}
                  </li>
                ))}
              </ol>

              <div
                style={{
                  padding: '12px 16px', borderRadius: 10,
                  background: 'rgba(201,146,42,0.1)',
                  border: '1px solid rgba(201,146,42,0.25)',
                  fontSize: 13, color: 'var(--d-text-2, #999)',
                }}
              >
                <span style={{ color: 'var(--d-gold, #c9922a)', fontWeight: 600 }}>Admin URL: </span>
                {adminUrl}
              </div>

              <button type="button" className="st-action" onClick={() => setStep(2)}>
                I have the key →
              </button>
            </div>
          ) : (
            /* ── Step 2: Paste the key and start ── */
            <form onSubmit={handleSubmit} style={{ display: 'grid', gap: 18 }}>
              <div>
                <div
                  style={{
                    fontSize: 22, fontWeight: 800,
                    fontFamily: 'var(--font-heading, sans-serif)',
                    letterSpacing: '-0.01em', marginBottom: 8,
                  }}
                >
                  PASTE YOUR KEY
                </div>
                <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--d-text-2, #999)' }}>
                  Paste the key you copied from Admin → Stations. It is saved on this tablet
                  only and never sent back to the server in readable form.
                </div>
              </div>

              <label style={{ display: 'grid', gap: 6 }}>
                <span className="st-diag">STATION KEY</span>
                <input
                  className="st-input"
                  type="password"
                  autoComplete="off"
                  autoFocus
                  value={value}
                  onChange={(e) => { setValue(e.target.value); setError(null); }}
                  placeholder="paste the key here"
                />
              </label>

              <label style={{ display: 'grid', gap: 6 }}>
                <span className="st-diag">
                  STATION CODE — label under the screen, e.g. ZDQA (optional if one station)
                </span>
                <input
                  className="st-input"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="leave blank if you only have one station"
                  maxLength={4}
                />
              </label>

              {error !== null && (
                <div
                  style={{
                    padding: '10px 14px', borderRadius: 8,
                    background: 'rgba(220,60,60,0.15)',
                    border: '1px solid rgba(220,60,60,0.3)',
                    fontSize: 13, color: '#ff9d92',
                  }}
                >
                  {error}
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  type="button"
                  className="st-action"
                  style={{ background: 'rgba(255,255,255,0.08)', color: 'var(--d-text-2, #999)', flex: 'none', padding: '14px 20px' }}
                  onClick={() => setStep(1)}
                >
                  ← Back
                </button>
                <button type="submit" className="st-action" style={{ flex: 1 }}>
                  Start display
                </button>
              </div>

              <div style={{ fontSize: 12, color: 'var(--d-text-3, #666)', lineHeight: 1.5 }}>
                If this tablet is ever lost or stolen, go to Admin → Stations and click Revoke.
                The display goes dark within 30 seconds.
              </div>
            </form>
          )}
        </div>
      </div>

      <footer className="st-foot">
        <div className="st-diag">Not configured</div>
        <button
          type="button"
          className="st-diag"
          style={{ background: 'none', border: 0, cursor: 'pointer', color: 'var(--d-text-3)' }}
          onClick={() => forgetStationCredential()}
        >
          Clear stored key
        </button>
      </footer>
    </div>
  );
}
