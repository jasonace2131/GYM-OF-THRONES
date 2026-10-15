'use client';

import { useState } from 'react';
import { API_URL } from '@/lib/apiBase';

/**
 * The enquiry form — the thing the "contact" section did not have.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * BEFORE THIS, A VISITOR NOT READY TO JOIN HAD NO WAY TO LEAVE THEIR DETAILS.
 *
 * `ContactSection` had no `<form>`, no input, no state and no fetch — four
 * static text tiles and a link to `/register`. The only path off the landing
 * page was "create an account now", which is a large ask of somebody still
 * deciding, and every one of them left with nothing recorded.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Four fields, single column, in the order people expect. Industry practice
 * is 3–5; each extra one measurably costs completions, so `phone` earns its
 * place only because this gym answers on Messenger and by phone more than by
 * email, and `message` is optional.
 *
 * Deliberately NOT using `apiFetch`: that helper attaches a Supabase token
 * and mints an `Idempotency-Key` on every POST. This endpoint is public,
 * anonymous, and not idempotent-keyed, so a plain `fetch` is both simpler and
 * more honest about what is being sent.
 */
export default function ContactForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  // The honeypot. Never shown, never focusable, only ever filled by a bot.
  const [website, setWebsite] = useState('');

  const [state, setState] = useState<'idle' | 'sending' | 'sent'>('idle');
  const [error, setError] = useState<string | null>(null);

  const contactable = email.trim() !== '' || phone.trim() !== '';
  const canSend = name.trim() !== '' && contactable && state === 'idle';

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canSend) return;

    setState('sending');
    setError(null);

    try {
      const response = await fetch(`${API_URL}/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          // Omitted rather than sent empty: the DTO treats absent as "not
          // given" and an empty string as a value that fails validation.
          ...(email.trim() === '' ? {} : { email: email.trim() }),
          ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
          ...(message.trim() === '' ? {} : { message: message.trim() }),
          ...(website === '' ? {} : { website }),
        }),
      });

      if (!response.ok) {
        // 429 is the one worth naming — it is the only failure a real person
        // hits, and "try again in a minute" is actionable where a generic
        // error is not.
        setError(
          response.status === 429
            ? 'That is a few too many messages. Please try again in a minute.'
            : 'That did not send. Please try again, or call us on 0966 205 9526.',
        );
        setState('idle');
        return;
      }

      setState('sent');
    } catch {
      setError('We could not reach the gym. Please try again, or call 0966 205 9526.');
      setState('idle');
    }
  };

  if (state === 'sent') {
    return (
      <div className="cform-done" role="status">
        <div className="cform-tick" aria-hidden>
          <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
            <path
              d="M20 6L9 17l-5-5"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h3>Thanks, {name.split(' ')[0]}</h3>
        <p>
          We have your message and will get back to you shortly. If it is urgent, call{' '}
          <a href="tel:+639662059526">0966 205 9526</a>.
        </p>
      </div>
    );
  }

  return (
    <form className="cform" onSubmit={(event) => void submit(event)} noValidate>
      <div className="field">
        <label htmlFor="cf-name">Your name</label>
        <input
          id="cf-name"
          className="input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          autoComplete="name"
          required
          disabled={state === 'sending'}
        />
      </div>

      <div className="field-row">
        <div className="field">
          <label htmlFor="cf-email">Email</label>
          <input
            id="cf-email"
            className="input"
            type="email"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            disabled={state === 'sending'}
          />
        </div>

        <div className="field">
          <label htmlFor="cf-phone">Mobile</label>
          <input
            id="cf-phone"
            className="input"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            autoComplete="tel"
            placeholder="0917 000 0000"
            disabled={state === 'sending'}
          />
        </div>
      </div>

      <p className="cform-hint">Either one is enough — whichever you would rather we used.</p>

      <div className="field">
        <label htmlFor="cf-message">
          Message <span className="cform-opt">optional</span>
        </label>
        <textarea
          id="cf-message"
          className="input cform-textarea"
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="Asking about rates, a trial, or class schedules?"
          maxLength={2000}
          disabled={state === 'sending'}
        />
      </div>

      {/*
        The honeypot: hidden from people, filled in by bots that read the raw
        HTML. `aria-hidden` and `tabIndex={-1}` keep it away from screen
        readers and keyboard users too — a hidden field a blind visitor can
        still tab into and complete would block their genuine enquiry.

        It is checked SERVER-side. A client-side check is one the bot skips by
        posting directly, which is what most of them do.
      */}
      <div className="cform-hp" aria-hidden>
        <label htmlFor="cf-website">Website</label>
        <input
          id="cf-website"
          name="website"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={(event) => setWebsite(event.target.value)}
        />
      </div>

      {error !== null && (
        <div className="cform-error" role="alert">
          {error}
        </div>
      )}

      <button type="submit" className="btn btn-gold btn-block" disabled={!canSend}>
        {state === 'sending' ? 'SENDING…' : 'SEND MESSAGE'}
      </button>

      <p className="cform-legal">
        We use your details only to reply. See our <a href="/privacy">privacy notice</a>.
      </p>
    </form>
  );
}
