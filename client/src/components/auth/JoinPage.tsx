'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MemberJoinLookup } from '@got/shared';
import AuthBrandPanel from './AuthBrandPanel';
import { NewPasswordFields } from './NewPasswordFields';
import { BirthDateInput } from '@/components/inputs/BirthDateInput';
import { supabase } from '@/lib/supabase';
import { ApiError, apiFetch } from '@/lib/api';
import { normalisePassword } from '@/lib/credentials';
import { newPasswordProblem, passwordRefusalMessage } from '@/lib/passwordRules';
import { homeFor, type HeldPermission } from '@/lib/safeNext';
import {
  asksDateOfBirth,
  birthDateProblem,
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

/** LoginPage's heading, so every auth screen opens the same way. */
const heading = {
  fontFamily: 'var(--font-heading)',
  fontWeight: 800,
  fontSize: 'clamp(32px, 4vw, 44px)',
  letterSpacing: '-0.01em',
  margin: '14px 0 8px',
  color: 'var(--text)',
  textTransform: 'uppercase',
} as const;

/** The paragraph under the heading; the last one before the actions keeps the 30px. */
const lead = {
  fontSize: 14.5,
  lineHeight: 1.6,
  color: 'var(--text-2)',
  margin: '0 0 30px',
} as const;

/** A lead paragraph that another one follows. */
const leadFirst = { ...lead, margin: '0 0 12px' } as const;

const column = { display: 'flex', flexDirection: 'column', gap: 18 } as const;

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
 * (choose a password, date of birth unless the desk entered it, finish). The
 * password is saved with Supabase BEFORE `accept`, so a failed accept never
 * leaves them without one; the date of birth, under 12 included, is checked
 * before either.
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
  /** The password was refused: the rules still unmet show as missing, not "to do". */
  const [passwordTried, setPasswordTried] = useState(false);
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
    const passwordProblem = newPasswordProblem(next, confirm);
    if (passwordProblem !== null) {
      setProblem({ title: 'Choose a password', body: passwordProblem });
      setPasswordTried(true);
      return;
    }
    const askDate = asksDateOfBirth(joinLink);
    const dobProblem = askDate ? birthDateProblem(dateOfBirth, localToday()) : null;
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
          setProblem({ title: 'Your password was not saved', body: passwordRefusalMessage(error) });
          setBusy(false);
          return;
        }
        savedPassword.current = next;
      }
      await memberJoinApi.accept(token, askDate ? dateOfBirth : undefined);
      const me = await apiFetch<{ permissions: HeldPermission[] }>('/me');
      // Stays busy: the page is leaving, and a live button would invite a second
      // submit while the portal loads.
      router.replace(homeFor(me.permissions));
    } catch (caught) {
      setProblem(joinErrorCopy(caught instanceof ApiError ? caught.code : null));
      setBusy(false);
    }
  }, [password, confirm, dateOfBirth, joinLink, token, router]);

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    setProblem(null);
  };

  const stage = joinStage({ lookup, link: joinLink, sessionEmail });

  // Rendered inside each face, directly above its primary button.
  const problemAlert =
    problem === null ? null : (
      <div role="alert" style={errorBox}>
        <strong style={{ display: 'block', marginBottom: 4 }}>{problem.title}</strong>
        {problem.body}
      </div>
    );
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
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Account set-up</span>

          <h1 style={heading}>
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
              <Link href="/login" className="btn btn-gold btn-block btn-auth">
                GO TO SIGN IN
              </Link>
            </>
          ) : null}

          {(stage === 'signed-out' || stage === 'signed-in-other') && joinLink !== null ? (
            <>
              <p style={stage === 'signed-in-other' ? leadFirst : lead}>
                This account is for <strong>{joinLink.email}</strong>. You&apos;ll choose a password
                next. The link works once, for 7 days.
              </p>
              {stage === 'signed-in-other' ? (
                <p style={lead}>
                  This computer is signed in as <strong>{sessionEmail}</strong>. Setting up signs
                  that account out here.
                </p>
              ) : null}
              <div style={column}>
                {problemAlert}
                <button
                  type="button"
                  className="btn btn-gold btn-block btn-auth"
                  disabled={busy}
                  onClick={() => void setUp()}
                >
                  {busy ? 'SETTING UP…' : 'SET UP MY ACCOUNT'}
                </button>
              </div>
            </>
          ) : null}

          {stage === 'signed-in' && joinLink !== null ? (
            <>
              <p style={lead}>
                Signed in as <strong>{sessionEmail}</strong>. Choose a password so you can sign in
                again next time.
              </p>
              <form
                style={column}
                onSubmit={(event) => {
                  event.preventDefault();
                  void finish();
                }}
              >
                <NewPasswordFields
                  password={password}
                  confirm={confirm}
                  onPasswordChange={setPassword}
                  onConfirmChange={setConfirm}
                  labels={{ password: 'Password', confirm: 'Confirm password' }}
                  names={{ password: 'password', confirm: 'confirm' }}
                  placeholder="••••••••"
                  showMissing={passwordTried}
                  disabled={busy}
                />
                {asksDateOfBirth(joinLink) ? (
                  <div className="field">
                    <label htmlFor="join-dob">Date of birth</label>
                    <BirthDateInput
                      id="join-dob"
                      className="input"
                      today={localToday()}
                      value={dateOfBirth}
                      onChange={setDateOfBirth}
                      required
                    />
                  </div>
                ) : null}

                {problemAlert}

                <button
                  type="submit"
                  className="btn btn-gold btn-block btn-auth"
                  style={{ marginTop: 4 }}
                  disabled={busy}
                >
                  {busy ? 'SAVING…' : 'FINISH SETTING UP'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-block btn-auth"
                  disabled={busy}
                  onClick={() => void signOut()}
                >
                  NOT YOU? SIGN OUT
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
