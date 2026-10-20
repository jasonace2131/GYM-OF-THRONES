'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  PERMISSIONS,
  type ActiveCheckIn,
  type DeskTodayPayload,
} from '@got/shared';
import { Card, CardHead } from '@/components/portal/ui';
import { Badge } from '@/components/portal/ui';
import { DataState, Kpi, Person } from '@/components/admin/ui';
import { ManualCheckIn } from '@/components/admin/ManualCheckIn';
import { CheckOutConfirm } from '@/components/admin/CheckOutConfirm';
import { NewMemberDrawer } from '@/components/admin/NewMemberDrawer';
import { usePermission } from '@/components/rbac/MeProvider';
import { adminApi, duration, gymTime } from '@/lib/adminApi';
import { seedFromGuest, type NewMemberSeed } from '@/lib/memberSeed';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { STAFF_QR_PATH } from '@/lib/stationAuth';

/**
 * The live desk view.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS SCREEN POLLS, AND THAT IS THE DESIGNED FALLBACK — NOT A SHORTCUT.
 *
 * The server also exposes `GET /front-desk/stream` (SSE), which is the live
 * channel a mounted desk console should use. This screen uses the polling
 * endpoint on purpose: `GET /front-desk/today?since=` is BOTH the fallback
 * when the stream will not open AND the reconnect catch-up after it drops, so
 * exercising it on the busiest CRM screen is what keeps it from rotting into
 * dead code that fails the first time it is genuinely needed.
 *
 * The cursor keys on `updatedAt`, not `createdAt` — a CHECK-OUT is an UPDATE,
 * and keying on creation makes every departure invisible to a poller.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The denial rail tells staff who was just turned away, live. It sells nothing
 * (owner, 2026-10-20: no walk-in button here; walk-ins are sold from the
 * dashboard or the Walk-ins page). `staffMessage` is the server's directive —
 * the blunt form that never went to the member's phone — rendered verbatim.
 */

/** Three seconds. Fast enough to feel live at a counter, slow enough to be free. */
const POLL_MS = 3_000;

export default function AdminAttendancePage() {
  const [feed, setFeed] = useState<DeskTodayPayload | null>(null);
  const [stale, setStale] = useState(false);

  // The guest→member conversion. `member.create` is the same key that gates
  // POST /members AND the guest-contact read — a caller without it would 403
  // on both, so the button simply is not there.
  const canConvert = usePermission(PERMISSIONS.MEMBER_CREATE);
  const router = useRouter();
  const [converting, setConverting] = useState<NewMemberSeed | null>(null);
  const [convertFetching, setConvertFetching] = useState<string | null>(null);
  // The visit whose "Check out" is waiting on its confirmation.
  const [checkingOut, setCheckingOut] = useState<ActiveCheckIn | null>(null);
  // The same code the lobby tablet paints, on this screen, from the staff
  // member's own login — `checkin.station_token.issue` is the key the token
  // route checks on that path.
  const canShowQr = usePermission(PERMISSIONS.CHECKIN_STATION_TOKEN_ISSUE);

  const startConvert = (checkInId: string): void => {
    setConvertFetching(checkInId);
    void adminApi
      .checkInGuest(checkInId)
      .then((guest) => setConverting({ ...seedFromGuest(guest), fromCheckInId: checkInId }))
      .catch(() => {
        // A 404 here means the visit was voided or is not a guest after all —
        // the drawer still opens, just unseeded, and the operator types.
        setConverting({});
      })
      .finally(() => setConvertFetching(null));
  };

  const cursorRef = useRef<string | undefined>(undefined);
  const feedRef = useRef<DeskTodayPayload | null>(null);

  useEffect(() => {
    feedRef.current = feed;
  }, [feed]);

  const active = useAdminQuery(
    useCallback(() => adminApi.activeCheckIns({ limit: 50 }), []),
    'active',
  );

  useEffect(() => {
    let stopped = false;

    const poll = async (): Promise<void> => {
      try {
        const next = await adminApi.today(cursorRef.current);
        if (stopped) return;

        setStale(false);
        cursorRef.current = next.cursor;

        setFeed((previous) => {
          // A `?since=` response is a DELTA. Merging rather than replacing is
          // what makes the poll cheap; replacing would blank the rail every
          // three seconds on a quiet evening.
          if (previous === null) return next;
          return {
            ...next,
            arrivals: mergeById(next.arrivals, previous.arrivals, (row) => row.checkInId),
            denials: mergeById(next.denials, previous.denials, (row) => row.denialId),
          };
        });
      } catch {
        // A dropped poll is not an empty gym. The last good feed stays on
        // screen and the live dot goes hollow — the same tell the station
        // display uses, for the same reason.
        if (!stopped) setStale(true);
      }
    };

    const kickoff = window.setTimeout(() => void poll(), 0);
    const id = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(kickoff);
      window.clearInterval(id);
    };
  }, []);

  const counters = feed?.counters;
  const unresolved = (feed?.denials ?? []).filter((d) => d.outcome === 'UNRESOLVED');
  const station = feed?.stations[0];

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* No "Needs you" tile (owner, 2026-10-20): with the walk-in button gone
          nothing on this page resolves a denial, so its count only climbed. */}
      <div className="a-kpis a-kpis--3">
        <Kpi value={counters?.inGym ?? '—'} label="In the gym now" />
        <Kpi value={counters?.today ?? '—'} label="Check-ins today" />
        <Kpi
          value={counters?.manualToday ?? '—'}
          label="Recorded by staff"
          // It was a fraud signal. It is now ALSO a coverage signal, and a
          // high number usually means the wifi is bad rather than that staff
          // is cheating.
          delta="high usually means bad wi-fi"
        />
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
        <span className="a-live">
          <span className="a-live-dot" data-live={!stale} aria-hidden />
          {stale ? 'Reconnecting — showing the last good view' : 'Live'}
        </span>

        {station === undefined ? null : (
          <span className="a-live">
            <span className="a-live-dot" data-live={station.live} aria-hidden />
            Station {station.code} · {station.live ? 'painting codes' : 'dark'}
          </span>
        )}

        {canShowQr ? (
          <a
            href={STAFF_QR_PATH}
            target="_blank"
            rel="noopener noreferrer"
            className="p-btn p-btn-ghost p-btn-sm"
            style={{ marginLeft: 'auto' }}
          >
            Show check-in QR ↗
          </a>
        ) : null}
      </div>

      <div
        style={{
          display: 'grid',
          gap: 18,
          gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
        }}
      >
        <ManualCheckIn
          onRecorded={() => {
            // Both boards, not one: an entry changes who is inside AND the
            // day's arrivals, and a console that refreshes half of itself
            // teaches staff to reload the page.
            cursorRef.current = undefined;
            active.reload();
          }}
        />

        <Card>
          <CardHead
            title="Needs you"
            action={
              <Badge tone={unresolved.length > 0 ? 'warn' : 'neutral'}>{unresolved.length}</Badge>
            }
          />

          {feed === null ? (
            <span className="p-muted">Loading…</span>
          ) : unresolved.length === 0 ? (
            <span className="p-muted">
              Nobody is waiting. Denials appear here the moment they happen.
            </span>
          ) : (
            <div style={{ display: 'grid', gap: 10 }}>
              {unresolved.map((denial) => (
                <div key={denial.denialId} className="a-denial">
                  <Person
                    firstName={denial.member.firstName}
                    lastName={denial.member.lastName}
                    sub={denial.member.memberCode}
                    avatarUrl={denial.member.avatarUrl}
                  />
                  {/* The STAFF directive — the blunt form that never travelled
                      to the member's handset. Rendered verbatim: the server
                      composes it so both surfaces cannot contradict each
                      other in front of the same person. */}
                  <p className="a-denial-say">{denial.staffMessage}</p>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 }}>
                    <span className="p-muted">{gymTime(denial.at)}</span>
                    {denial.offSiteOrigin ? (
                      // A quiet chip. It denies nobody and never has — members
                      // on cellular inside the building are entirely
                      // legitimate.
                      <span className="p-badge p-badge-neutral">off-site network</span>
                    ) : null}
                    {denial.tokenStalenessSeconds === null ? null : (
                      <span className="p-badge p-badge-neutral">
                        code {denial.tokenStalenessSeconds}s stale
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <CardHead title="Arrivals" />
          {feed === null ? (
            <span className="p-muted">Loading…</span>
          ) : feed.arrivals.length === 0 ? (
            <span className="p-muted">No arrivals yet today.</span>
          ) : (
            <div>
              {feed.arrivals.slice(0, 20).map((arrival) => (
                <div key={`${arrival.checkInId}:${arrival.kind}`} className="a-arrival">
                  <Person
                    firstName={arrival.member.firstName}
                    lastName={arrival.member.lastName}
                    sub={arrival.member.planName}
                    avatarUrl={arrival.member.avatarUrl}
                  />
                  <span style={{ marginLeft: 'auto', textAlign: 'right' }}>
                    <Badge tone={arrival.kind === 'CHECK_IN' ? 'ok' : 'neutral'}>
                      {arrival.kind === 'CHECK_IN' ? 'in' : 'out'}
                    </Badge>
                    <div className="a-person-sub">{gymTime(arrival.at)}</div>
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead title="In the gym now" />
        </div>
        <DataState
          loading={active.loading}
          error={active.error}
          empty={(active.data?.items.length ?? 0) === 0}
          emptyTitle="The building is empty"
          emptyHint="Anyone not checked out by hand is checked out automatically after closing time."
          onRetry={active.reload}
        >
          <div className="a-scroll">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Since</th>
                  <th className="p-num">For</th>
                  <th>How</th>
                  <th>Station</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {active.data?.items.map((row) => (
                  <tr key={row.checkInId}>
                    <td>
                      <Person
                        firstName={row.member.firstName}
                        lastName={row.member.lastName}
                        sub={row.member.memberCode ?? row.member.planName}
                        avatarUrl={row.member.avatarUrl}
                      />
                    </td>
                    <td>{gymTime(row.occurredAt)}</td>
                    <td className="p-num">{duration(row.durationMinutes)}</td>
                    <td>
                      <Badge tone={row.verdict === 'ALLOWED' ? 'ok' : 'warn'}>
                        {row.method === 'STATION_QR' ? 'scan' : 'desk'}
                      </Badge>
                    </td>
                    <td className="p-muted">{row.station?.code ?? '—'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {/* A guest in the building is the warmest lead the gym
                            has. `userId === null` is the guest predicate the
                            desk feed already carries. */}
                        {canConvert && row.member.userId === null ? (
                          <button
                            type="button"
                            className="p-btn p-btn-gold p-btn-sm"
                            disabled={convertFetching !== null}
                            onClick={() => startConvert(row.checkInId)}
                          >
                            {convertFetching === row.checkInId ? 'Opening…' : 'Make member'}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="p-btn p-btn-ghost p-btn-sm"
                          onClick={() => setCheckingOut(row)}
                        >
                          Check out
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </Card>

      {converting !== null && (
        <NewMemberDrawer
          seed={converting}
          onClose={() => setConverting(null)}
          onCreated={() => {
            cursorRef.current = undefined;
            active.reload();
          }}
          onOpenMember={() => router.push('/admin/members')}
        />
      )}

      <CheckOutConfirm
        visit={checkingOut}
        onClose={() => setCheckingOut(null)}
        onDone={() => {
          cursorRef.current = undefined;
          active.reload();
        }}
      />
    </div>
  );
}

/**
 * Newest-wins merge, preserving order.
 *
 * A `?since=` page carries only what CHANGED, so a check-out arrives as an
 * updated row with the same id as the arrival already on screen — replacing by
 * id rather than appending is what stops the same visit appearing twice.
 */
function mergeById<T>(incoming: T[], existing: T[], idOf: (row: T) => string): T[] {
  const seen = new Set(incoming.map(idOf));
  return [...incoming, ...existing.filter((row) => !seen.has(idOf(row)))].slice(0, 100);
}
