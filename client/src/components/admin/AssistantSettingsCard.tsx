'use client';

import { useCallback, useRef, useState } from 'react';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { ReplyBody } from '@/components/assistant/ReplyBody';
import { adminApi, type AssistantSettingsView } from '@/lib/adminApi';
import { assistantErrorMessage } from '@/lib/assistant/errors';
import { checkInstructions, counterLabel, editedLabel } from '@/lib/assistantSettings';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ConfirmDialog } from './actions/ConfirmDialog';

/**
 * What the member assistant is told about the gym and how to answer
 * (feat/assistant-settings, 2026-10-14).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SAFETY RULES ARE SHOWN, NOT EDITED.
 *
 * The server appends them after whatever is saved here, and they say they
 * override it — never invent a price or a date, never claim to have renewed or
 * booked anything, only the member's own data. They are on this card so the
 * admin can see what the assistant is held to, not so they can change it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Try it" runs the UNSAVED draft, so an edit can be checked before members
 * see it. It spends the same free Gemini quota members use.
 */
export function AssistantSettingsCard() {
  const query = useAdminQuery(
    useCallback(() => adminApi.assistantSettings(), []),
    'assistant-settings',
  );

  // `null` = not editing: the textarea shows what is saved.
  const [draft, setDraft] = useState<string | null>(null);
  // Which write is in flight: both lock the editor, only a save says "Saving…".
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // The dialog's own error, so a failed save never shows up inside it and a
  // failed reset is announced once, in the dialog, not again behind it.
  const [resetError, setResetError] = useState<string | null>(null);

  // The view a save or reset just returned, pinned to the `query.data` it
  // replaced. `useAdminQuery` keeps the old data on screen during `reload()`,
  // so without this the textarea flashes the previous text until the refetch
  // lands. Any new `query.data` object (that refetch, or a later one) unpins it.
  const [written, setWritten] = useState<{
    view: AssistantSettingsView;
    basis: AssistantSettingsView | null;
  } | null>(null);
  const [showRules, setShowRules] = useState(false);

  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [replyError, setReplyError] = useState<string | null>(null);
  // Bumped whenever the draft changes, so an answer to the old text that
  // lands afterwards is dropped instead of shown under "your unsaved draft".
  const draftVersion = useRef(0);

  const clearReply = (): void => {
    draftVersion.current += 1;
    setReply(null);
    setReplyError(null);
  };

  const view = written !== null && written.basis === query.data ? written.view : query.data;
  const saved = view?.instructions ?? '';
  const text = draft ?? saved;
  const check = checkInstructions(text, saved, view?.maxLength ?? 6000);

  const save = async (): Promise<void> => {
    setBusy('save');
    setError(null);
    try {
      const next = await adminApi.saveAssistantInstructions(text.trim());
      setWritten({ view: next, basis: query.data });
      setDraft(null);
      clearReply();
      query.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(null);
    }
  };

  const reset = async (): Promise<void> => {
    setBusy('reset');
    setResetError(null);
    try {
      const next = await adminApi.resetAssistantInstructions();
      setWritten({ view: next, basis: query.data });
      setDraft(null);
      setError(null);
      clearReply();
      setConfirmingReset(false);
      query.reload();
    } catch (caught) {
      setResetError(caught instanceof Error ? caught.message : 'That did not reset.');
    } finally {
      setBusy(null);
    }
  };

  const ask = async (): Promise<void> => {
    // Every question can cost several Gemini calls from the members' shared
    // free quota, so one at a time — as the member assistant page does.
    if (asking) return;
    const trimmedQuestion = question.trim();
    if (trimmedQuestion === '' || check.blank || check.tooLong) return;

    setAsking(true);
    setReply(null);
    setReplyError(null);
    const version = draftVersion.current;
    try {
      const result = await adminApi.tryAssistantDraft(text.trim(), trimmedQuestion);
      if (version === draftVersion.current) setReply(result.answer);
    } catch (caught) {
      if (version === draftVersion.current) setReplyError(assistantErrorMessage(caught));
    } finally {
      setAsking(false);
    }
  };

  return (
    <Card padded={false}>
      <div style={{ padding: '18px 18px 0' }}>
        <CardHead
          title="AI assistant"
          action={
            view ? (
              <Badge tone={view.isDefault ? 'neutral' : 'info'}>{editedLabel(view)}</Badge>
            ) : undefined
          }
        />
      </div>

      <DataState
        loading={query.loading}
        error={query.error}
        empty={false}
        emptyTitle="No instructions"
        onRetry={query.reload}
      >
        {view ? (
          <div style={{ display: 'grid', gap: 14, padding: '0 18px 18px' }}>
            <p className="p-muted" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
              What the member assistant is told about the gym and how to answer: its name and
              location, the tone, what it covers and how long it writes. Members see the change on
              their next question.
            </p>

            <label style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Instructions</span>
              <textarea
                className="a-textarea"
                value={text}
                rows={14}
                disabled={busy !== null}
                onChange={(event) => {
                  setDraft(event.target.value);
                  clearReply();
                }}
                aria-describedby="assistant-instructions-count"
                style={{ fontFamily: 'inherit', lineHeight: 1.5 }}
              />
              <span
                id="assistant-instructions-count"
                style={{
                  fontSize: 12,
                  justifySelf: 'end',
                  color: check.tooLong || check.blank ? 'var(--p-danger)' : 'var(--p-ink2)',
                }}
              >
                {check.blank
                  ? 'Instructions cannot be empty'
                  : `${counterLabel(check.length, view.maxLength)} characters`}
              </span>
            </label>

            <p className="p-muted" style={{ fontSize: 12.5, margin: 0 }}>
              Members can get the assistant to repeat these instructions keep anything private out
              of them.
            </p>

            <div>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => setShowRules((open) => !open)}
                aria-expanded={showRules}
              >
                {showRules ? 'Hide' : 'Show'} the locked safety rules
              </button>
              {showRules ? (
                <div style={{ marginTop: 8 }}>
                  <p className="p-muted" style={{ fontSize: 12.5, margin: '0 0 6px' }}>
                    Always added after your instructions, and they win any conflict. They cannot be
                    edited here.
                  </p>
                  <pre
                    style={{
                      margin: 0,
                      padding: 12,
                      whiteSpace: 'pre-wrap',
                      fontFamily: 'inherit',
                      fontSize: 12.5,
                      lineHeight: 1.55,
                      background: 'var(--p-paper2)',
                      borderRadius: 'var(--p-radius)',
                    }}
                  >
                    {view.safetyRules}
                  </pre>
                </div>
              ) : null}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>
                Try it <span className="p-muted">(uses your unsaved draft)</span>
              </span>
              {view.enabled ? (
                <>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      className="a-input"
                      value={question}
                      maxLength={2000}
                      disabled={asking}
                      placeholder="What time do you open on Sunday?"
                      onChange={(event) => setQuestion(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && !event.repeat) void ask();
                      }}
                      style={{ flex: '1 1 240px' }}
                      aria-label="Test question"
                    />
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => void ask()}
                      disabled={asking || question.trim() === '' || check.blank || check.tooLong}
                    >
                      {asking ? 'Asking…' : 'Ask'}
                    </button>
                  </div>
                  {replyError !== null ? (
                    <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: 0 }}>
                      {replyError}
                    </p>
                  ) : null}
                  {reply !== null ? (
                    <div
                      style={{
                        padding: 12,
                        borderRadius: 'var(--p-radius)',
                        fontSize: 14,
                        lineHeight: 1.55,
                        background: 'var(--p-paper2)',
                      }}
                    >
                      <ReplyBody text={reply} />
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="p-muted" style={{ fontSize: 13, margin: 0 }}>
                  The assistant is switched off on this server (no Gemini key), so it cannot answer
                  a test question. You can still edit and save the instructions.
                </p>
              )}
            </div>

            {error !== null ? (
              <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: 0 }}>
                {error}
              </p>
            ) : null}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => {
                  setResetError(null);
                  setConfirmingReset(true);
                }}
                disabled={busy !== null || view.isDefault}
              >
                Reset to default
              </button>
              {draft !== null && check.dirty ? (
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                    clearReply();
                  }}
                  disabled={busy !== null}
                >
                  Discard
                </button>
              ) : null}
              <button
                type="button"
                className="p-btn p-btn-gold p-btn-sm"
                onClick={() => void save()}
                disabled={busy !== null || !check.canSave}
              >
                {busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : null}
      </DataState>

      <ConfirmDialog
        open={confirmingReset}
        title="Put the built-in instructions back?"
        consequence="Your edited instructions are replaced by the original ones on members' next question. The old text stays in the audit log."
        confirmLabel="Reset to default"
        cancelLabel="Keep my instructions"
        busy={busy !== null}
        error={resetError}
        onConfirm={() => void reset()}
        onClose={() => {
          if (busy !== null) return;
          setConfirmingReset(false);
          setResetError(null);
        }}
      />
    </Card>
  );
}
