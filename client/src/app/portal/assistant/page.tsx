'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { apiFetch } from '@/lib/api';
import {
  availabilityCopy,
  availabilityFromError,
  availabilityFromStatus,
  type AssistantAvailability,
} from '@/lib/assistant/availability';
import { assistantErrorMessage } from '@/lib/assistant/errors';
import { ReplyBody } from '@/components/assistant/ReplyBody';
import { assistantTimeoutSignal, pendingLabel } from '@/lib/assistant/pending';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';

/**
 * The member assistant.
 *
 * Answers from the member's OWN data only — the server's tools take no user
 * identifier at all, so there is no parameter through which another member
 * could be named. That is enforced server-side; this screen just talks to it.
 *
 * Read-only by construction: the assistant has no write tools, so it can
 * explain how to freeze a membership but never freeze one. Every change still
 * happens with staff at the counter.
 */

interface Turn {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * The chat column, centred in the page: a 760px strip pinned to the sidebar
 * edge left the rest of a laptop screen empty (owner, 2026-10-15). The loading
 * skeleton uses it too, so the page does not jump sideways when status lands.
 */
const COLUMN = { maxWidth: 760, width: '100%', marginInline: 'auto' } as const;

const SUGGESTIONS = [
  'When does my membership expire?',
  'How many times have I been this month?',
  'How much is the annual plan?',
  'How do I freeze my membership?',
  'Make me a 3-day beginner workout plan',
];

/**
 * Gated on `ai.chat.use`, the key both of its routes check members hold it,
 * staff do not — so staff are no longer offered an assistant that 403s.
 */
export default function AssistantPage() {
  return (
    <RequirePermission permission={PERMISSIONS.AI_CHAT_USE}>
      <Assistant />
    </RequirePermission>
  );
}

function Assistant() {
  const [availability, setAvailability] = useState<AssistantAvailability | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  // The question in flight and how long it has been waiting, for the label
  // under it. A weekly plan can take half a minute on the free tier.
  const [asked, setAsked] = useState('');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const conversationId = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // A 403 and a dropped connection are not "switched off" — see availability.ts.
  const fetchStatus = useCallback((): void => {
    void apiFetch<{ enabled: boolean }>('/me/assistant/status')
      .then((status) => setAvailability(availabilityFromStatus(status)))
      .catch((caught: unknown) => setAvailability(availabilityFromError(caught)));
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  const checkStatus = (): void => {
    setAvailability(null);
    fetchStatus();
  };

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, busy]);

  // Ticks only while a question is in flight; reset to 0 in `send`.
  useEffect(() => {
    if (!busy) return;
    const startedAt = Date.now();
    const id = window.setInterval(() => setElapsedMs(Date.now() - startedAt), 1_000);
    return () => window.clearInterval(id);
  }, [busy]);

  const send = async (text: string): Promise<void> => {
    const message = text.trim();
    if (message === '' || busy) return;

    setDraft('');
    setError(null);
    setTurns((prev) => [...prev, { role: 'user', content: message }]);
    setAsked(message);
    setElapsedMs(0);
    setBusy(true);

    try {
      const reply = await apiFetch<{ conversationId: string; answer: string }>(
        '/me/assistant/messages',
        {
          method: 'POST',
          body: JSON.stringify({
            message,
            ...(conversationId.current === null ? {} : { conversationId: conversationId.current }),
          }),
          // Longer than the server's own budget, so the server's reason
          // ("ask for a shorter plan") normally arrives before this fires.
          signal: assistantTimeoutSignal(),
        },
      );
      conversationId.current = reply.conversationId;
      setTurns((prev) => [...prev, { role: 'assistant', content: reply.answer }]);
    } catch (caught) {
      // The member's own message stays on screen — retyping a question because
      // the network blipped is the wrong thing to ask of somebody.
      setError(assistantErrorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (availability === null) {
    return (
      <div style={{ ...COLUMN, display: 'grid', gap: 18 }}>
        <Skeleton height={80} />
        <Skeleton height={200} />
      </div>
    );
  }

  if (availability !== 'on') {
    const copy = availabilityCopy(availability);
    return (
      <EmptyState
        title={copy.title}
        hint={copy.hint}
        action={
          copy.retry ? (
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={checkStatus}>
              Try again
            </button>
          ) : undefined
        }
      />
    );
  }

  return (
    <div style={{ ...COLUMN, display: 'grid', gap: 16 }}>
      <Card>
        <p style={{ margin: 0, fontSize: 13.5, color: 'var(--p-ink2)', lineHeight: 1.55 }}>
          Ask about your membership, your visits, your payments, or the gym&rsquo;s hours and prices
          — or about training, from how to do an exercise to a weekly workout plan built around your
          schedule. It only ever sees <strong>your own</strong> records, and it cannot change
          anything — renewals, freezes and payments all happen at the front desk.
        </p>
      </Card>

      {turns.length === 0 ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => void send(suggestion)}
            >
              {suggestion}
            </button>
          ))}
        </div>
      ) : null}

      <div style={{ display: 'grid', gap: 12 }}>
        {turns.map((turn, index) => (
          <div
            key={`${index}-${turn.role}`}
            style={{
              justifySelf: turn.role === 'user' ? 'end' : 'start',
              maxWidth: '86%',
              padding: '11px 15px',
              borderRadius: 14,
              fontSize: 14.5,
              lineHeight: 1.6,
              whiteSpace: turn.role === 'user' ? 'pre-wrap' : 'normal',
              background: turn.role === 'user' ? 'var(--gold)' : 'var(--p-surface2)',
              color: turn.role === 'user' ? '#1a1408' : 'var(--p-ink)',
              border: turn.role === 'user' ? 'none' : '1px solid var(--p-border)',
            }}
          >
            {turn.role === 'assistant' ? <ReplyBody text={turn.content} /> : turn.content}
          </div>
        ))}

        {/*
          Always mounted, so a screen reader is already watching the live
          region when the first label arrives; empty and unpadded when idle.
          It doubles as the scroll anchor the old empty div was.
        */}
        <div
          ref={endRef}
          role="status"
          aria-live="polite"
          style={{
            justifySelf: 'start',
            padding: busy ? '11px 15px' : 0,
            fontSize: 14,
            color: 'var(--p-ink3)',
          }}
        >
          {busy ? pendingLabel(asked, elapsedMs) : null}
        </div>
      </div>

      {error === null ? null : (
        <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>
          {error}
        </p>
      )}

      <form
        style={{ display: 'flex', gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <input
          className="a-input"
          style={{ flex: 1 }}
          value={draft}
          maxLength={2000}
          disabled={busy}
          placeholder="Ask something…"
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" className="p-btn p-btn-gold" disabled={busy || draft.trim() === ''}>
          Ask
        </button>
      </form>
    </div>
  );
}
