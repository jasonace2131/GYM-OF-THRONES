'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { StaffInvitationLookup } from '@got/shared';
import AuthBrandPanel from './AuthBrandPanel';
import { PasswordInput } from './PasswordInput';
import { supabase } from '@/lib/supabase';
import { ApiError, apiFetch } from '@/lib/api';
import { inviteApi } from '@/lib/staffApi';
import { normalisePassword } from '@/lib/credentials';
import { homeFor, type HeldPermission } from '@/lib/safeNext';
import {
  acceptErrorCopy,
  deadInviteCopy,
  INVITE_HEADLINE,
  inviteRoleNote,
  inviteRoleSentence,
  inviteStage,
  signInHref,
  type InviteCopy,
  type LookupState,
  type MatchState,
  type SessionState,
} from '@/lib/staff/invitePage';

/**
 * "Set up my account" leaves for Supabase and comes back signed in to a
 * brand-new account that has no password yet. This marker is how the page
 * knows, on return, to ask for one before accepting — without it the new
 * staff member would be signed in today and locked out tomorrow.
 */
const claimedKey = (token: string): string => `got:invite-claimed:${token}`;

function readClaimed(token: string): boolean {
  try {
    return window.sessionStorage.getItem(claimedKey(token)) === '1';
  } catch {
    return false;
  }
}

function writeClaimed(token: string, value: boolean): void {
  try {
    if (value) window.sessionStorage.setItem(claimedKey(token), '1');
    else window.sessionStorage.removeItem(claimedKey(token));
  } catch {
    // Private mode or blocked storage: the password step is simply skipped,
    // and "Forgot password" still works for them later.
  }
}

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

/**
 * `/invite/[token]` — a staff invitation, opened from its email or a link an
 * admin sent.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PAGE NEVER CHOOSES A ROLE. It shows the one the invitation carries
 * (the lookup), and "Accept" sends back only the token; the server reads the
 * role off the invitation and checks the signed-in address against it.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Five faces: loading; a dead link (expired, withdrawn, used, not valid — each
 * with its own sentence); signed out ("Set up my account", or sign in if the
 * address already has one); signed in as somebody else, typically the admin
 * who sent it ("Sign out and continue", no Accept); signed in as the invited
 * address ("Accept", plus a password if the account was set up just now).
 */
export default function InvitePage({ token }: { token: string }) {
  const router = useRouter();
  const [lookup, setLookup] = useState<LookupState>('loading');
  const [invitation, setInvitation] = useState<StaffInvitationLookup | null>(null);
  const [deadCode, setDeadCode] = useState<string | null>(null);
  const [session, setSession] = useState<SessionState>('checking');
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [needsPassword, setNeedsPassword] = useState(false);
  const [signInInstead, setSignInInstead] = useState(false);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<InviteCopy | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  /** The match answer, and which signed-in address it was asked for. */
  const [matchResult, setMatchResult] = useState<{ email: string; state: MatchState } | null>(null);

  useEffect(() => {
    let cancelled = false;
    inviteApi.lookup(token).then(
      (found) => {
        if (cancelled) return;
        setInvitation(found);
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
      if (cancelled) return;
      setSignedInAs(email ?? null);
      setSession(email === null || email === undefined ? 'signed-out' : 'signed-in');
      setNeedsPassword(email !== null && email !== undefined && readClaimed(token));
    };

    void supabase.auth.getSession().then(({ data }) => apply(data.session?.user.email ?? null));
    // The account link comes back with the session in the URL fragment;
    // `detectSessionInUrl` turns it into a session a moment after mount.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      apply(next?.user.email ?? null);
    });

    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [token]);

  // Is the signed-in account the invited one? Asked again whenever the session
  // changes hands. Any failure falls back to offering Accept, which the server
  // still refuses for the wrong account; a LOGIN_CODE_REQUIRED never lands
  // here, because apiFetch sends the browser to the code step first.
  useEffect(() => {
    if (lookup !== 'ok' || signedInAs === null) return;
    const email = signedInAs;
    let cancelled = false;
    inviteApi.match(token).then(
      (answer) => {
        if (!cancelled) setMatchResult({ email, state: answer.matches ? 'match' : 'mismatch' });
      },
      () => {
        if (!cancelled) setMatchResult({ email, state: 'unknown' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [lookup, signedInAs, token]);

  const setUp = useCallback(async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      const claim = await inviteApi.claimLink(token);
      if (claim.kind === 'REDIRECT') {
        writeClaimed(token, true);
        window.location.assign(claim.url);
        return;
      }
      setSignInInstead(true);
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : null;
      setProblem(
        code === 'STAFF_INVITE_DISABLED'
          ? {
              title: 'Account set-up is not available right now',
              body: 'If you already have an account, sign in below. Otherwise, let the gym know.',
            }
          : acceptErrorCopy(code, invitation?.maskedEmail ?? ''),
      );
    } finally {
      setBusy(false);
    }
  }, [token, invitation]);

  const accept = useCallback(async (): Promise<void> => {
    setProblem(null);
    if (needsPassword) {
      const next = normalisePassword(password);
      if (next.length < 8) {
        setProblem({ title: 'Choose a password', body: 'Use at least 8 characters.' });
        return;
      }
      if (next !== normalisePassword(confirm)) {
        setProblem({ title: 'Choose a password', body: 'The two passwords do not match.' });
        return;
      }
    }

    setBusy(true);
    try {
      if (needsPassword) {
        const { error } = await supabase.auth.updateUser({ password: normalisePassword(password) });
        if (error !== null) {
          setProblem({ title: 'Your password was not saved', body: error.message });
          return;
        }
        writeClaimed(token, false);
        setNeedsPassword(false);
      }

      await inviteApi.accept(token);
      const me = await apiFetch<{ permissions: HeldPermission[] }>('/me');
      router.replace(homeFor(me.permissions));
    } catch (caught) {
      setProblem(
        acceptErrorCopy(
          caught instanceof ApiError ? caught.code : null,
          invitation?.maskedEmail ?? '',
        ),
      );
    } finally {
      setBusy(false);
    }
  }, [needsPassword, password, confirm, token, router, invitation]);

  /** Back to the signed-out face: onAuthStateChange flips the session to signed-out. */
  const signOut = async (): Promise<void> => {
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
    } finally {
      setSigningOut(false);
      setProblem(null);
    }
  };

  const match: MatchState =
    matchResult !== null && matchResult.email === signedInAs ? matchResult.state : 'checking';
  const stage = inviteStage({ lookup, session, match });

  // Rendered inside each face, directly above its primary button.
  const problemAlert =
    problem === null ? null : (
      <div role="alert" style={errorBox}>
        <strong style={{ display: 'block', marginBottom: 4 }}>{problem.title}</strong>
        {problem.body}
      </div>
    );
  const dead = deadInviteCopy(deadCode);

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-e.webp"
        imageAlt="Gym floor"
        backLabel="← GYM OF THRONES"
        onBack={() => router.push('/')}
        headline={['JOIN', 'THE', 'TEAM']}
        kicker="House of Fitness · Est 2023"
        blurb="Your staff invitation — set up your account and you're in."
      />

      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Staff invitation</span>

          <h1 style={heading}>
            {stage === 'dead'
              ? dead.title
              : invitation === null
                ? 'Opening your invitation…'
                : INVITE_HEADLINE}
          </h1>

          {stage === 'loading' ? (
            <p style={lead} aria-busy="true">
              Checking your invitation…
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

          {stage === 'signed-out' && invitation !== null ? (
            <>
              <p style={signInInstead ? leadFirst : lead}>
                {inviteRoleSentence(invitation.role)} This invitation is for{' '}
                <strong>{invitation.maskedEmail}</strong>. It works for 7 days from when it was
                sent.
              </p>

              {signInInstead ? (
                <>
                  <p style={lead}>
                    You already have an account with this address. Sign in and you will come
                    straight back here to accept. Never set a password? Use &ldquo;Forgot
                    password&rdquo; on the sign-in page.
                  </p>
                  <div style={column}>
                    {problemAlert}
                    <Link href={signInHref(token)} className="btn btn-gold btn-block btn-auth">
                      SIGN IN TO ACCEPT
                    </Link>
                  </div>
                </>
              ) : (
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
                  <Link href={signInHref(token)} style={{ fontSize: 13, textAlign: 'center' }}>
                    Already have an account? Sign in
                  </Link>
                </div>
              )}
            </>
          ) : null}

          {stage === 'wrong-account' && invitation !== null ? (
            <>
              <p style={leadFirst}>
                You&apos;re signed in as <strong>{signedInAs}</strong>. This invitation is for{' '}
                <strong>{invitation.maskedEmail}</strong>. {inviteRoleNote(invitation.role)}
              </p>
              <p style={lead}>Sign out here, then set up or sign in with that address.</p>
              <div style={column}>
                {problemAlert}
                <button
                  type="button"
                  className="btn btn-gold btn-block btn-auth"
                  disabled={signingOut}
                  onClick={() => void signOut()}
                >
                  {signingOut ? 'SIGNING OUT…' : 'SIGN OUT AND CONTINUE'}
                </button>
              </div>
            </>
          ) : null}

          {stage === 'signed-in' && invitation !== null ? (
            <>
              <p style={needsPassword ? leadFirst : lead}>
                Signed in as <strong>{signedInAs}</strong>. The invitation is for{' '}
                <strong>{invitation.maskedEmail}</strong>. {inviteRoleNote(invitation.role)}
              </p>
              {needsPassword ? (
                <p style={lead}>Choose a password, so you can sign in again next time.</p>
              ) : null}

              <form
                style={column}
                onSubmit={(event) => {
                  event.preventDefault();
                  void accept();
                }}
              >
                {needsPassword ? (
                  <>
                    <div className="field">
                      <label htmlFor="invite-password">Password</label>
                      <PasswordInput
                        id="invite-password"
                        placeholder="••••••••"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="invite-confirm">Confirm password</label>
                      <PasswordInput
                        id="invite-confirm"
                        placeholder="••••••••"
                        value={confirm}
                        onChange={(event) => setConfirm(event.target.value)}
                        autoComplete="new-password"
                        minLength={8}
                        required
                      />
                    </div>
                  </>
                ) : null}

                {problemAlert}

                <button
                  type="submit"
                  className="btn btn-gold btn-block btn-auth"
                  // LoginPage's 4px above a submit that follows fields.
                  style={needsPassword ? { marginTop: 4 } : undefined}
                  disabled={busy || signingOut}
                >
                  {busy ? 'ACCEPTING…' : 'ACCEPT INVITATION'}
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-block btn-auth"
                  disabled={busy || signingOut}
                  onClick={() => void signOut()}
                >
                  {signingOut ? 'SIGNING OUT…' : 'NOT YOU? SIGN OUT'}
                </button>
              </form>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
