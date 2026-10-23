'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CHAT_MESSAGE_MAX_LENGTH, type ChatParty } from '@got/shared';
import { GYM_TIMEZONE } from '@/lib/gymTime';
import { canDeleteMessage, threadTimeline, type TimelineItem } from '@/lib/chat/chatState';
import { initialsOf, messageTime, otherParty } from '@/lib/chat/format';
import { groupTimeline } from '@/lib/chat/groups';
import { useChat } from './RealtimeProvider';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

/**
 * One conversation: its history, a composer, and the states around them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * PLAIN TEXT, ALWAYS. A body is rendered as a React text node with
 * `white-space: pre-wrap` — never as HTML, never through a markdown or link
 * parser. A coach and a member are the only two people who can write here,
 * and neither should be able to put markup on the other's screen.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Laid out like a messenger (owner, 2026-10-06): my bubbles on the right,
 * theirs on the left under their avatar, runs from one person grouped
 * (`groupTimeline`) so only the last bubble carries the time, and a divider
 * for each gym day. The panel fills whatever height its parent gives it — a
 * full-height pane in the inbox, `height` elsewhere.
 *
 * Mounting it OPENS the thread (history loaded or caught up, marked read, its
 * incoming messages not counted unread); unmounting closes it. Every rule
 * about who may write is the server's — `writable` here only decides whether
 * a composer is worth showing.
 */
export function ChatPanel({
  threadId,
  title,
  height = 'min(70vh, 640px)',
  embedded = false,
}: {
  threadId: string;
  /** The header row's contents — usually a `<ChatHeader>`. */
  title?: ReactNode;
  /** CSS height; `null` when the parent (CSS) sizes the panel. */
  height?: number | string | null;
  /** Inside a frame of its own (the inbox): no second border or radius. */
  embedded?: boolean;
}) {
  const chat = useChat();
  // A lapsed member reads the conversation but may not send (owner,
  // 2026-10-17). Always true for a coach: no membership gate wraps the inbox.
  const canWrite = useMemberCanWrite();
  const openThread = chat?.openThread;
  const closeThread = chat?.closeThread;

  useEffect(() => {
    if (openThread === undefined || closeThread === undefined) return;
    openThread(threadId);
    return () => closeThread(threadId);
  }, [threadId, openThread, closeThread]);

  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const log = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const stickToBottom = useRef(true);
  const heightBeforeOlder = useRef<number | null>(null);

  // Re-evaluate "Remove" windows and "today" once a minute.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const state = chat?.state;
  const items: TimelineItem[] = state === undefined ? [] : threadTimeline(state, threadId);
  const thread = state?.threads[threadId];
  const loaded = state?.hasOlder[threadId] !== undefined;
  const hasOlder = state?.hasOlder[threadId] === true;
  const lastKey =
    items.length === 0
      ? 'none'
      : ((last) => (last.kind === 'message' ? last.message.id : last.pending.clientId))(
          items[items.length - 1],
        );
  const firstKey = items[0]?.kind === 'message' ? items[0].message.id : 'none';

  // Keep the newest message in view as they arrive — unless the reader has
  // scrolled up to read something older.
  useLayoutEffect(() => {
    const box = log.current;
    if (box === null) return;
    if (heightBeforeOlder.current !== null) {
      // "Load earlier" prepended rows: hold the reader's place.
      box.scrollTop += box.scrollHeight - heightBeforeOlder.current;
      heightBeforeOlder.current = null;
      return;
    }
    if (stickToBottom.current) box.scrollTop = box.scrollHeight;
  }, [lastKey, firstKey, loaded]);

  // The composer grows with what is typed, up to its max-height, then scrolls.
  useLayoutEffect(() => {
    const box = input.current;
    if (box === null) return;
    // border-box sizing: scrollHeight excludes the 1px borders, so add them
    // back or the box is always 2px short and shows a scrollbar. It scrolls
    // only once it reaches its CSS max-height.
    box.style.height = 'auto';
    const border = box.offsetHeight - box.clientHeight;
    box.style.height = `${box.scrollHeight + border}px`;
    box.style.overflowY = box.scrollHeight + border > box.offsetHeight ? 'auto' : 'hidden';
  }, [draft]);

  if (chat === null || state === undefined) return null;

  const them: ChatParty | null = thread === undefined ? null : otherParty(thread);
  const rows = groupTimeline(items, now, GYM_TIMEZONE);

  const onScroll = (): void => {
    const box = log.current;
    if (box === null) return;
    stickToBottom.current = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  };

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text === '' || thread?.writable !== true) return;
    setError(null);
    setDraft('');
    stickToBottom.current = true;
    const failure = await chat.send(threadId, text);
    if (failure !== null) {
      // Rolled back in the reducer; the words come back to the composer.
      setDraft((current) => (current === '' ? text : current));
      setError(failure);
    }
  };

  const loadOlder = async (): Promise<void> => {
    heightBeforeOlder.current = log.current?.scrollHeight ?? null;
    await chat.loadOlder(threadId);
  };

  return (
    <div
      className="p-chat"
      data-embedded={embedded}
      style={height === null ? undefined : { height }}
    >
      {title === undefined ? null : <div className="p-chat-head">{title}</div>}

      <div
        className="p-chat-log"
        ref={log}
        onScroll={onScroll}
        role="log"
        aria-live="polite"
        aria-relevant="additions"
        aria-label="Messages"
      >
        {hasOlder ? (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm p-chat-older"
            onClick={() => void loadOlder()}
          >
            Load earlier messages
          </button>
        ) : null}

        {!loaded ? (
          <p className="p-chat-empty">Loading the conversation…</p>
        ) : items.length === 0 ? (
          <p className="p-chat-empty">
            No messages yet.
            {thread?.writable === true && them !== null ? ` Say hello to ${them.firstName}.` : ''}
          </p>
        ) : null}

        {rows.map((row) => {
          if (row.kind === 'day') {
            return (
              <div key={row.key} className="p-chat-day" role="separator">
                {row.label}
              </div>
            );
          }

          const { item, mine, first, last } = row;
          const avatar = mine || them === null ? null : <Avatar party={them} hidden={!last} />;

          if (item.kind === 'pending') {
            return (
              <div
                key={row.key}
                className="p-msg"
                data-mine="true"
                data-first={first}
                data-last={last}
              >
                <div className="p-msg-body">
                  <div className="p-bubble" data-state="pending">
                    {item.pending.body}
                  </div>
                  {last ? <div className="p-msg-meta">Sending…</div> : null}
                </div>
              </div>
            );
          }

          const { message } = item;
          const removable = canDeleteMessage(message, state.meId, now) && thread?.writable === true;
          const asking = confirming === message.id;

          return (
            <div
              key={row.key}
              className="p-msg"
              data-mine={mine}
              data-first={first}
              data-last={last}
            >
              {avatar}
              <div className="p-msg-body">
                <div className="p-msg-line">
                  <div className="p-bubble" data-deleted={message.body === null}>
                    {message.body ?? 'Message removed'}
                  </div>
                  {removable && !asking ? (
                    <button
                      type="button"
                      className="p-msg-remove"
                      onClick={() => setConfirming(message.id)}
                      aria-label="Remove this message"
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
                {last || asking ? (
                  <div className="p-msg-meta">
                    {last ? (
                      <time dateTime={message.createdAt}>
                        {messageTime(message.createdAt, now, GYM_TIMEZONE)}
                      </time>
                    ) : null}
                    {asking ? (
                      <>
                        <span>Remove it for both of you?</span>
                        <button
                          type="button"
                          onClick={() => {
                            setConfirming(null);
                            void chat.remove(message.id).then((failure) => {
                              if (failure !== null) setError(failure);
                            });
                          }}
                        >
                          Remove
                        </button>
                        <button type="button" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>

      {chat.connection === 'offline' ? (
        <div className="p-chat-notice" role="status">
          Reconnecting… new messages will appear when the connection is back.
        </div>
      ) : null}

      {thread !== undefined && !thread.writable ? (
        <div className="p-chat-notice">
          This coaching has ended, so the conversation is kept as read-only history.
        </div>
      ) : !canWrite ? (
        <div className="p-chat-notice">Renew your membership to message your coach again.</div>
      ) : (
        <form
          className="p-chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <label className="sr-only" htmlFor={`chat-compose-${threadId}`}>
              Message
            </label>
            <textarea
              ref={input}
              id={`chat-compose-${threadId}`}
              className="p-chat-input"
              rows={1}
              value={draft}
              maxLength={CHAT_MESSAGE_MAX_LENGTH}
              placeholder={them === null ? 'Write a message' : `Message ${them.firstName}`}
              disabled={thread === undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                if (error !== null) setError(null);
              }}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a new line; an IME mid-word is left alone.
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            {error !== null ? (
              <p role="alert" className="p-chat-hint" style={{ color: 'var(--p-danger)' }}>
                {error}
              </p>
            ) : draft.length > CHAT_MESSAGE_MAX_LENGTH - 200 ? (
              <p className="p-chat-hint p-muted">
                {CHAT_MESSAGE_MAX_LENGTH - draft.length} characters left
              </p>
            ) : null}
          </div>
          <button
            type="submit"
            className="p-chat-send"
            disabled={draft.trim() === '' || thread === undefined}
            aria-label="Send"
          >
            <SendIcon />
          </button>
        </form>
      )}
    </div>
  );
}

/**
 * The header row of a conversation: who it is with, a line about them, and
 * the actions that go with it. `onBack` adds the phone's "back to all
 * conversations" arrow (hidden on wider screens, where the list is beside it).
 */
export function ChatHeader({
  party,
  subtitle,
  actions,
  onBack,
}: {
  party: ChatParty;
  subtitle?: ReactNode;
  actions?: ReactNode;
  onBack?: () => void;
}) {
  return (
    <>
      {onBack === undefined ? null : (
        <button
          type="button"
          className="p-chat-back"
          onClick={onBack}
          aria-label="Back to all conversations"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M15 18l-6-6 6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}
      <PartyAvatar party={party} className="p-avatar-md" size={44} />
      <div className="p-chat-who">
        <span className="p-chat-name">
          {party.firstName} {party.lastName}
        </span>
        {subtitle === undefined ? null : <span className="p-chat-sub">{subtitle}</span>}
      </div>
      {actions === undefined ? null : <div className="p-chat-actions">{actions}</div>}
    </>
  );
}

/** A person's photo, or their initials when there is none. */
export function PartyAvatar({
  party,
  className,
  size,
}: {
  party: Pick<ChatParty, 'firstName' | 'lastName' | 'avatarUrl'>;
  className: string;
  size: number;
}) {
  return party.avatarUrl === null ? (
    <span className={className} aria-hidden>
      {initialsOf(party)}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img className={className} src={party.avatarUrl} alt="" width={size} height={size} />
  );
}

function Avatar({ party, hidden }: { party: ChatParty; hidden: boolean }) {
  return party.avatarUrl === null ? (
    <span className="p-msg-avatar" data-hidden={hidden} aria-hidden>
      {initialsOf(party)}
    </span>
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="p-msg-avatar"
      data-hidden={hidden}
      src={party.avatarUrl}
      alt=""
      width={30}
      height={30}
    />
  );
}

function SendIcon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M4.5 12h11M4 5.5l15.5 6.5L4 18.5l2.6-6.5L4 5.5z"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
