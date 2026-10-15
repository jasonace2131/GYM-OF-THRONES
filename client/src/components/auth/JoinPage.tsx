'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MemberJoinLookup } from '@got/shared';
import AuthBrandPanel from './AuthBrandPanel';
import { PasswordInput } from './PasswordInput';
import { supabase } from '@/lib/supabase';
import { ApiError, apiFetch } from '@/lib/api';
import { normalisePassword } from '@/lib/credentials';
import { homeFor, type HeldPermission } from '@/lib/safeNext';
import {
  birthDateProblem,
  dayBefore,
  deadJoinCopy,
  isSamePasswordError,
  joinErrorCopy,
  joinStage,
  memberJoinApi,
  passwordStep,
  type JoinCopy,
  type JoinLookupState,
} from '@/lib/memberJoin';

const errorBox = {
  padding: '11px 14px',
  borderRadius: 7,
  border: '1px solid rgba(255,90,70,.4)',
  background: 'rgba(255,90,70,.1)',
  color: '#ff9d92',
  fontSize: 13,
  lineHeight: 1.5,
} as const;

const lead = {
  fontSize: 14.5,
  lineHeight: 1.6,
  color: 'var(--text-2)',
  margin: '0 0 24px',
} as const;

/** Today as `yyyy-mm-dd` in the browser's calendar — only the form's own checks use it. */
function localToday(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * `/join/[token]` — a member created at the front desk finishing their account.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PASSWORD FORM IS SHOWN ONLY TO THE MEMBER THE LINK WAS MADE FOR.
 * `joinStage` compares the signed-in session's email with the link's: on a desk
 * PC signed in as staff, the page offers "Set up my account" (which signs the
 * member in instead) and never a form that would change the staff password.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Faces: loading; dead (already set up, expired, not valid); signed out or
 * signed in as somebody else ("Set up my account"); signed in as the member
 * (choose a password, date of birth, finish). The password is saved with
 * Supabase BEFORE `accept`, so a failed accept never leaves them without one.
 */
export default function JoinPage({ token }: { token: string }) {
  const router = useRouter();
  const [lookup, setLookup] = useState<JoinLookupState>('loading');
  const [joinLink, setJoinLink] = useState<MemberJoinLookup | null>(null);
  const [deadCode, setDeadCode] = useState<string | null>(null);
  const [sessionEmail, setSessionEmail] = useState<string | null | undefined>(undefined);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<JoinCopy | null>(null);
  /** The normalised password this page has already saved with Supabase, if any. */
  const savedPassword = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    memberJoinApi.lookup(token).then(
      (found) => {
        if (cancelled) return;
        setJoinLink(found);
        setLookup('ok');
      },
      (caught: unknown) => {
        if (cancelled) return;
        setDeadCode(caught instanceof ApiError ? caught.code : null);
        setLookup('dead');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => {
    let cancelled = false;
    const apply = (email: string | null | undefined): void => {
      if (!cancelled) setSessionEmail(email ?? null);
    };
    void supabase.auth.getSession().then(({ data }) => apply(data.session?.user.email ?? null));
    // The sign-in link comes back with the session in the URL fragment;
    // `detectSessionInUrl` turns it into a session a moment after mount.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      apply(next?.user.email ?? null);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const setUp = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const claim = await memberJoinApi.claimLink(token);
      window.location.assign(claim.url);
    } catch (caught) {
      setProblem(joinErrorCopy(caught instanceof ApiError ? caught.code : null));
      setBusy(false);
    }
  }, [token]);

  const finish = useCallback(async (): Promise<void> => {
    setProblem(null);
    const next = normalisePassword(password);
    if (next.length < 8) {
      setProblem({ title: 'Choose a password', body: 'Use at least 8 characters.' });
      return;
    }
    if (next !== normalisePassword(confirm)) {
      setProblem({ title: 'Choose a password', body: 'The two passwords do not match.' });
      return;
    }
    const dobProblem = birthDateProblem(dateOfBirth, localToday());
    if (dobProblem !== null) {
      setProblem({ title: 'Date of birth', body: dobProblem });
      return;
    }

    setBusy(true);
    try {
      // The spec's "a retry just sets the password again" does not survive
      // Supabase's same_password rule, so a saved password is not saved twice.
      if (passwordStep({ next, savedPassword: savedPassword.current }) === 'save') {
        const { error } = await supabase.auth.updateUser({ password: next });
        if (error !== null && !isSamePasswordError(error)) {
          setProblem({ title: 'Your password was not saved', body: error.message });
          setBusy(false);
          return;
        }
        savedPassword.current = next;
      }
      await memberJoinApi.accept(token, dateOfBirth);
      const me = await apiFetch<{ permissions: HeldPermission[] }>('/me');
      // Stays busy: the page is leaving, and a live button would invite a second
      // submit while the portal loads.
      router.replace(homeFor(me.permissions));
    } catch (caught) {
      setProblem(joinErrorCopy(caught instanceof ApiError ? caught.code : null));
      setBusy(false);
    }
  }, [password, confirm, dateOfBirth, token, router]);

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    setProblem(null);
  };

  const stage = joinStage({ lookup, link: joinLink, sessionEmail });
  const dead = deadJoinCopy({ status: joinLink?.status ?? null, code: deadCode });

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-e.webp"
        imageAlt="Gym floor"
        backLabel="← GYM OF THRONES"
        onBack={() => router.push('/')}
        headline={['YOUR', 'MEMBERSHIP', 'AWAITS']}
        kicker="House of Fitness · Est 2023"
        blurb="Your account was created at the front desk — finish it here and you're in."
      />

      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 420, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Account set-up</span>

          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: 'clamp(26px, 3.4vw, 36px)',
              letterSpacing: '-0.01em',
              lineHeight: 1.15,
              margin: '14px 0 12px',
              color: 'var(--text)',
            }}
          >
            {stage === 'dead'
              ? dead.title
              : joinLink === null
                ? 'Opening your link…'
                : `Hi ${joinLink.firstName} — set up your account`}
          </h1>

          {stage === 'loading' ? (
            <p style={lead} aria-busy="true">
              Checking your link…
            </p>
          ) : null}

          {stage === 'dead' ? (
            <>
              <p style={lead}>{dead.body}</p>
              <Link href="/login" className="btn btn-gold btn-block">
                GO TO SIGN IN
              </Link>
            </>
          ) : null}

          {(stage === 'signed-out' || stage === 'signed-in-other') && joinLink !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <p style={{ ...lead, margin: 0 }}>
                This account is for <strong>{joinLink.email}</strong>. You&apos;ll choose a password
                next. The link works once, for 7 days.
              </p>
              {stage === 'signed-in-other' ? (
                <p style={{ ...lead, margin: 0 }}>
                  This computer is signed in as <strong>{sessionEmail}</strong>. Setting up signs
                  that account out here.
                </p>
              ) : null}
              <button
                type="button"
                className="btn btn-gold btn-block"
                disabled={busy}
                onClick={() => void setUp()}
              >
                {busy ? 'SETTING UP…' : 'SET UP MY ACCOUNT'}
              </button>
            </div>
          ) : null}

          {stage === 'signed-in' && joinLink !== null ? (
            <form
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              onSubmit={(event) => {
                event.preventDefault();
                void finish();
              }}
            >
              <p style={{ ...lead, margin: 0 }}>
                Signed in as <strong>{sessionEmail}</strong>. Choose a password so you can sign in
                again next time.
              </p>
              <div className="field">
                <label htmlFor="join-password">Password</label>
                <PasswordInput
                  id="join-password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="join-confirm">Confirm password</label>
                <PasswordInput
                  id="join-confirm"
                  placeholder="••••••••"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="join-dob">Date of birth</label>
                <input
                  id="join-dob"
                  className="input"
                  type="date"
                  value={dateOfBirth}
                  max={dayBefore(localToday())}
                  onChange={(event) => setDateOfBirth(event.target.value)}
                  required
                />
              </div>

              <button type="submit" className="btn btn-gold btn-block" disabled={busy}>
                {busy ? 'SAVING…' : 'FINISH SETTING UP'}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-block"
                disabled={busy}
                onClick={() => void signOut()}
              >
                NOT YOU? SIGN OUT
              </button>
            </form>
          ) : null}

          {problem === null ? null : (
            <div role="alert" style={{ ...errorBox, marginTop: 16 }}>
              <strong style={{ display: 'block', marginBottom: 4 }}>{problem.title}</strong>
              {problem.body}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
