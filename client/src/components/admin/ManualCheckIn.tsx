'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CheckInResult } from '@got/shared';
import { ApiError } from '@/lib/api';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { useAdminQuery, useDebounced } from '@/lib/useAdminQuery';
import { Card, CardHead } from '@/components/portal/ui';
import { Person, StandingBadge } from './ui';
import { ConfirmDialog } from './actions/ConfirmDialog';

/** A check-in waiting on its confirmation: who, and exactly what will be sent. */
interface PendingCheckIn {
  label: string;
  body: { userId?: string; memberCode?: string };
  noPhoto: boolean;
}

/**
 * `F2 — CHECK IN BY NAME`. The desk's own way in.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE WORD "FALLBACK" APPEARS NOWHERE ON THIS SCREEN.
 *
 * A quarter of arrivals cannot self-scan on a given day — no smartphone, a
 * dead battery, a phone in a locker, no signal, a cracked screen, camera
 * permission denied months ago. That is not an exception; it is a path
 * carrying a quarter of traffic at three times the transaction time, and a
 * console that labels it "manual fallback" teaches staff to treat those
 * members as a problem.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE SEARCH IS THE WHOLE INTERACTION. One field, and it takes a name, a
 * member code, an email or a phone number — because the staffer does not know
 * in advance which of those the member will offer, and asking them to pick a
 * mode first is a decision made at the counter with a queue behind it.
 *
 * A TYPED CODE and a NAME PICK are sent differently on purpose: the server
 * records `MEMBER_CODE` for one and `MANUAL` for the other, which is what
 * lets a later review tell "they had their card" from "a staffer recognised
 * them". The UI decides which by whether the query IS a member code.
 */

/** Six characters of the member-code alphabet — Crockford base32, no I/L/O/U. */
const MEMBER_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{6}$/;

export function ManualCheckIn({ onRecorded }: { onRecorded: () => void }) {
  const [query, setQuery] = useState('');
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Owner decision: every staff write is confirmed, the desk's check-in
  // included. One extra click, with the name on it.
  const [pending, setPending] = useState<PendingCheckIn | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const debounced = useDebounced(query);
  const typedCode = MEMBER_CODE_PATTERN.test(query.trim().toUpperCase());

  const hits = useAdminQuery(
    useCallback(
      () =>
        debounced.trim().length < 2
          ? Promise.resolve(null)
          : adminApi.members({ search: debounced.trim(), limit: 6 }),
      [debounced],
    ),
    `desk-search:${debounced}`,
  );

  // F2 focuses the field from anywhere on the console. A staffer with a member
  // in front of them should never have to find a text box with a mouse.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'F2') return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const record = useCallback(
    async (body: { userId?: string; memberCode?: string }, noPhoto: boolean): Promise<void> => {
      setBusy(true);
      setError(null);
      try {
        const outcome = await adminApi.manualCheckIn({
          ...body,
          // Asserted EXPLICITLY when there is no photo: the operator is
          // vouching for recognition, and that is a claim someone makes on
          // purpose rather than one inferred from a missing column.
          ...(noPhoto ? { identityConfirmed: true } : {}),
        });
        setResult(outcome);
        setQuery('');
        setPending(null);
        onRecorded();
      } catch (caught) {
        setError(
          caught instanceof ApiError
            ? caught.code === 'SHIFT_NOT_OPEN'
              ? 'Open the cash drawer first — a staff-recorded entry has to be reconcilable to a till.'
              : caught.message
            : 'Something went wrong.',
        );
      } finally {
        setBusy(false);
      }
    },
    [onRecorded],
  );

  const submitTypedCode = (): void => {
    if (!typedCode) return;
    // No disambiguation step — the code IS the identification — but the
    // write itself is still confirmed, like every other staff edit.
    const code = query.trim().toUpperCase();
    setError(null);
    setPending({ label: `member ${code}`, body: { memberCode: code }, noPhoto: false });
  };

  return (
    <Card>
      {/* No header actions (owner, 2026-10-15): the F2 chip and "+ Walk-in"
          are gone. F2 still focuses the field; a walk-in off the street is
          sold from the dashboard or the Walk-ins page, and one behind a
          denial from "Needs you". */}
      <CardHead title="Check in by name" />

      <form
        className="a-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          submitTypedCode();
        }}
      >
        <input
          ref={inputRef}
          className="a-input"
          type="search"
          value={query}
          disabled={busy}
          placeholder="Name, member code, email or phone…"
          aria-label="Find the member"
          onChange={(event) => {
            setQuery(event.target.value);
            setResult(null);
            setError(null);
          }}
        />

        {typedCode ? (
          <button type="submit" className="p-btn p-btn-gold" disabled={busy}>
            Check in {query.trim().toUpperCase()}
          </button>
        ) : null}
      </form>

      {error === null ? null : (
        <p style={{ color: 'var(--p-danger)', fontSize: 14, marginTop: 12 }}>{error}</p>
      )}

      {result === null ? null : <Outcome result={result} />}

      {hits.data === null || result !== null ? null : (
        <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
          {hits.data.items.length === 0 ? (
            <span className="p-muted">Nobody matches that.</span>
          ) : (
            hits.data.items.map((hit) => (
              <Hit
                key={hit.userId}
                member={hit}
                busy={busy}
                onPick={(body, noPhoto) => {
                  setError(null);
                  setPending({ label: `${hit.firstName} ${hit.lastName}`, body, noPhoto });
                }}
              />
            ))
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={`Check in ${pending?.label ?? ''}?`}
        consequence={
          pending?.noPhoto
            ? 'There is no photo on file, so this records that you recognised them. The server decides whether they are admitted, and the answer shows here.'
            : 'Records a desk check-in in your name, now. The server decides whether they are admitted, and the answer shows here.'
        }
        confirmLabel="Check in"
        cancelLabel="Back"
        busy={busy}
        error={error}
        onConfirm={() => {
          if (pending !== null) void record(pending.body, pending.noPhoto);
        }}
        onClose={() => {
          if (!busy) setPending(null);
        }}
      />
    </Card>
  );
}

function Hit({
  member,
  busy,
  onPick,
}: {
  member: MemberListItem;
  busy: boolean;
  onPick: (body: { userId: string }, noPhoto: boolean) => void;
}) {
  const noPhoto = member.avatarUrl === null;

  return (
    <button
      type="button"
      className="a-hit"
      disabled={busy}
      onClick={() => onPick({ userId: member.userId }, noPhoto)}
    >
      <Person
        firstName={member.firstName}
        lastName={member.lastName}
        sub={member.memberCode ?? member.phone ?? member.email}
        avatarUrl={member.avatarUrl}
      />
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* The photo is the identity control on this path — its absence is
            said out loud rather than left for the operator to notice. */}
        {noPhoto ? <span className="p-badge p-badge-neutral">no photo</span> : null}
        <StandingBadge
          decision={member.decision}
          daysRemaining={member.membership?.daysRemaining ?? null}
          hasMembership={member.membership !== null}
        />
      </span>
    </button>
  );
}

/**
 * The outcome, in the DESK's voice.
 *
 * This renders `staffMessage`-equivalent volume: red for a refusal, loud, with
 * the reason spelled out. That is the deliberate opposite of the member's own
 * phone, which never goes red and never names the reason — the desk is the
 * authority and staff needs the volume; the member is standing in public.
 */
function Outcome({ result }: { result: CheckInResult }) {
  const { display, denial, session } = result;

  return (
    <div className="a-result" data-tone={display.tone} role="status" style={{ marginTop: 12 }}>
      <span className="a-result-head">{display.headline}</span>
      <span style={{ fontSize: 14 }}>{display.subhead}</span>
      {display.detail === null ? null : (
        <span style={{ fontSize: 14, opacity: 0.85 }}>{display.detail}</span>
      )}
      {denial === null ? null : (
        <span className="p-badge p-badge-danger" style={{ justifySelf: 'start' }}>
          {denial.reason.replace(/_/g, ' ').toLowerCase()}
        </span>
      )}
      {session === null ? null : (
        <span style={{ fontSize: 14 }}>{session.durationMinutes} minutes</span>
      )}
    </div>
  );
}
