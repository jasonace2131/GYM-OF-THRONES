'use client';

import { useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthBrandPanel from './AuthBrandPanel';
import { supabase } from '@/lib/supabase';
import { type HeldPermission, destinationFor } from '@/lib/safeNext';
import { EMAIL_INPUT_PROPS, normaliseIdentifier, normalisePassword } from '@/lib/credentials';
import { ApiError, apiFetch } from '@/lib/api';
import { PasswordInput } from './PasswordInput';

/** One retry before giving up, long enough to outlast a cold start. */
const RETRY_DELAY_MS = 600;

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // `null` when the caller did not ask for a destination — that distinction is
  // load-bearing and used to be erased here.
  //
  // ───────────────────────────────────────────────────────────────────────
  // THIS LINE USED TO READ `const next = safeNext(requested)`, AND THAT WAS
  // THE MISROUTE.
  //
  // `safeNext(null)` returns MEMBER_HOME, so `next` was ALWAYS
  // "/portal/dashboard" for a visitor who arrived with no `?next=` at all.
  // That value was then stamped onto this screen's own CREATE A MEMBER
  // ACCOUNT link; RegisterPage's BACK TO LOGIN handed it straight back as
  // `?next=/portal/dashboard`; and a `requested !== null` short-circuit below
  // made it beat the caller's real home. Repro, entirely without a `?next=`:
  // open /login → CREATE ACCOUNT → BACK TO LOGIN → sign in as ADMIN → member
  // portal. The destination is now resolved once, after /me, by
  // `destinationFor`, and `requested` is never laundered into a default.
  // ───────────────────────────────────────────────────────────────────────
  const requested = searchParams.get('next');

  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [stranded, setStranded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /** Resolve who this is, then go. Separated so Retry can re-run exactly it. */
  const routeByPermissions = async (token: string | undefined): Promise<void> => {
    const me = await apiFetch<{ permissions: HeldPermission[] }>('/me', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    router.replace(destinationFor(requested, me.permissions));
  };

  const resolveDestination = async (token: string | undefined): Promise<void> => {
    setStranded(false);
    try {
      await routeByPermissions(token);
    } catch (caught) {
      // A 401 here is not a blip — the session is genuinely unusable, so keep
      // the caller on the form rather than bouncing them into a shell that
      // will bounce them straight back. `admin/layout.tsx:46-59` documents
      // that loop; do not hand them a console link from here.
      if (caught instanceof ApiError && caught.status === 401) {
        await supabase.auth.signOut();
        setSubmitting(false);
        setError('That session could not be verified. Please sign in again.');
        return;
      }

      // EVERYTHING ELSE GETS ONE RETRY, AND THEN THE TRUTH.
      //
      // Deliberately not an `instanceof ApiError` branch: a CORS failure or a
      // dropped connection rejects `fetch` with a bare TypeError before
      // api.ts ever constructs an ApiError. The production incident this
      // guards against — CORS_ORIGIN unset on the API, so /me never returned —
      // would not have matched one.
      //
      // What it must NOT do is what it used to: silently send them to
      // MEMBER_HOME. That is indistinguishable from being a member, so every
      // admin in production was quietly demoted to the member portal by an
      // infrastructure fault, and the screen said nothing.
      try {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        await routeByPermissions(token);
      } catch {
        setSubmitting(false);
        setStranded(true);
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setStranded(false);
    setSubmitting(true);

    // Normalised before it leaves the browser. Supabase treats
    // "juan@example.com " as a different account, so a trailing space came
    // back as "Invalid login credentials" — the same message as a wrong
    // password, with nothing on screen to see. The password is deliberately
    // NOT trimmed: a space is a legal password character.
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email: normaliseIdentifier(identifier),
      password: normalisePassword(password),
    });

    if (signInError) {
      setSubmitting(false);
      setError(signInError.message);
      return;
    }

    // `submitting` stays true across the /me round trip and is cleared only by
    // a failure path. Clearing it here would repaint the button as SIGN IN
    // while the redirect is still in flight, and a second tap would re-submit.

    // WHERE SOMEBODY LANDS IS DECIDED BY THEIR PERMISSIONS, not their role and
    // not a fixed path — and `?next=` is now a REQUEST, not a command. It is
    // honoured when the caller may actually open it and dropped when they may
    // not, because a validated URL is not the same thing as a permitted one.
    //
    // Read the token from the sign-in result directly — NOT from a second
    // getSession() call. Supabase flushes the new session to its local store
    // asynchronously, so re-reading immediately after signInWithPassword can
    // race and return the OLD (or absent) token, causing a 401 on /me.
    await resolveDestination(signInData.session?.access_token);
  };

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-e.webp"
        imageAlt="Gym floor"
        backLabel="← BACK TO SITE"
        onBack={() => router.push('/')}
        headline={['WHERE', 'CHAMPIONS', 'TRAIN']}
        kicker="House of Fitness · Est 2023"
        blurb="Your premier fitness destination — equipment, coaching, and community."
      />

      {/* Form panel */}
      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Member &amp; staff access</span>

          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: 'clamp(32px, 4vw, 44px)',
              letterSpacing: '-0.01em',
              margin: '14px 0 8px',
              color: 'var(--text)',
            }}
          >
            SIGN IN
          </h1>
          <p
            style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 30px' }}
          >
            Manage your schedule, membership and payments.
          </p>

          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
          >
            <div className="field">
              <label htmlFor="login-identifier">Email or mobile number</label>
              <input
                id="login-identifier"
                className="input"
                type="text"
                placeholder="you@example.com"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                autoComplete="username"
                // Stops iOS capitalising the first letter and appending a
                // space. `type` stays "text" and inputMode is overridden back,
                // because this field also accepts a mobile number.
                {...EMAIL_INPUT_PROPS}
                inputMode="text"
                required
              />
            </div>

            <div className="field">
              <label htmlFor="login-password">Password</label>
              <PasswordInput
                id="login-password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
              <div style={{ textAlign: 'right', marginTop: 2 }}>
                {/* Was href="#" - a dead link for the whole of development,
                    and the only recovery path a member had. */}
                <Link href="/forgot-password" style={{ fontSize: 12.5 }}>
                  Forgot password?
                </Link>
              </div>
            </div>

            {error && (
              <div
                role="alert"
                style={{
                  padding: '11px 14px',
                  borderRadius: 7,
                  border: '1px solid rgba(255,90,70,.4)',
                  background: 'rgba(255,90,70,.1)',
                  color: '#ff9d92',
                  fontSize: 13,
                  lineHeight: 1.5,
                }}
              >
                {error}
              </div>
            )}

            {/*
              SIGNED IN, BUT WE DO NOT KNOW WHERE TO SEND THEM.
              The alternative — the one this replaces — was to guess the member
              portal and say nothing, which is how an API outage presented as
              "the admin dashboard is gone". Saying so is strictly better than
              a confident wrong answer, and both doors are offered because at
              this point the caller knows which one they want better than we do.
            */}
            {stranded && (
              <div
                role="alert"
                style={{
                  padding: '13px 15px',
                  borderRadius: 7,
                  border: '1px solid rgba(201,146,42,.42)',
                  background: 'rgba(201,146,42,.09)',
                  color: 'var(--text-2)',
                  fontSize: 13,
                  lineHeight: 1.55,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <span>
                  Signed in — but we could not reach the server to work out where to send you.
                </span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                  <button
                    type="button"
                    className="btn btn-gold"
                    style={{ padding: '8px 16px', fontSize: 12.5, letterSpacing: '0.08em' }}
                    onClick={() => {
                      setSubmitting(true);
                      void supabase.auth
                        .getSession()
                        .then(({ data }) => resolveDestination(data.session?.access_token));
                    }}
                  >
                    RETRY
                  </button>
                  <Link href="/portal/dashboard" style={{ fontSize: 12.5 }}>
                    Member portal
                  </Link>
                  <Link href="/admin" style={{ fontSize: 12.5 }}>
                    Staff console
                  </Link>
                </div>
              </div>
            )}

            <button
              id="login-submit-btn"
              type="submit"
              disabled={submitting}
              className="btn btn-gold btn-block"
              style={{
                padding: 14,
                fontSize: 14.5,
                letterSpacing: '0.12em',
                marginTop: 4,
                opacity: submitting ? 0.6 : 1,
                cursor: submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {submitting ? 'SIGNING IN…' : 'SIGN IN'}
            </button>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontFamily: 'var(--font-heading)',
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--text-3)',
              }}
            >
              <span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} />
              New here
              <span style={{ flex: 1, height: 1, background: 'var(--line-2)' }} />
            </div>

            {/*
              A BARE /register WHEN NOTHING WAS REQUESTED.
              Appending `next` unconditionally is what manufactured a `?next=`
              out of nothing and sent it round the register screen and back —
              see the block at the top of this file. Only a destination the
              caller genuinely asked for survives the round trip now.
            */}
            <Link
              id="login-register-btn"
              href={
                requested === null ? '/register' : `/register?next=${encodeURIComponent(requested)}`
              }
              className="btn btn-ghost btn-block"
              style={{ padding: 13, fontSize: 13.5, letterSpacing: '0.1em' }}
            >
              CREATE A MEMBER ACCOUNT
            </Link>
          </form>

          {/* Small reminder of what is behind the door */}
          <div
            style={{
              marginTop: 30,
              padding: '16px 18px',
              border: '1px solid var(--line)',
              borderRadius: 10,
              background: 'rgba(255,255,255,.02)',
              display: 'flex',
              alignItems: 'center',
              gap: 14,
            }}
          >
            <Image
              src="/assets/logo.webp"
              alt=""
              aria-hidden
              width={38}
              height={38}
              style={{
                borderRadius: '50%',
                objectFit: 'cover',
                border: '1px solid rgba(201,146,42,.45)',
                flex: 'none',
              }}
            />
            <p style={{ margin: 0, fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-3)' }}>
              Members get class booking, payment history and renewal reminders in one place.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
