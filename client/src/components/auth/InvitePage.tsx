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
  inviteHeadline,
  inviteStage,
  signInHref,
  type InviteCopy,
  type LookupState,
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

const lead = {
  fontSize: 14.5,
  lineHeight: 1.6,
  color: 'var(--text-2)',
  margin: '0 0 24px',
} as const;

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
 * Four faces: loading; a dead link (expired, withdrawn, used, not valid — each
 * with its own sentence); signed out ("Set up my account", or sign in if the
 * address already has one); signed in ("Accept", plus a password if the
 * account was set up just now).
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

  const signOut = async (): Promise<void> => {
    await supabase.auth.signOut();
    setProblem(null);
  };

  const stage = inviteStage({ lookup, session });
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
        <div style={{ width: '100%', maxWidth: 420, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Staff invitation</span>

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
              : invitation === null
                ? 'Opening your invitation…'
                : inviteHeadline(invitation.role)}
          </h1>

          {stage === 'loading' ? (
            <p style={lead} aria-busy="true">
              Checking your invitation…
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

          {stage === 'signed-out' && invitation !== null ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <p style={{ ...lead, margin: 0 }}>
                This invitation is for <strong>{invitation.maskedEmail}</strong>. It works for 7
                days from when it was sent.
              </p>

              {signInInstead ? (
                <>
                  <p style={{ ...lead, margin: 0 }}>
                    You already have an account with this address. Sign in and you will come
                    straight back here to accept. Never set a password? Use &ldquo;Forgot
                    password&rdquo; on the sign-in page.
                  </p>
                  <Link href={signInHref(token)} className="btn btn-gold btn-block">
                    SIGN IN TO ACCEPT
                  </Link>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn btn-gold btn-block"
                    disabled={busy}
                    onClick={() => void setUp()}
                  >
                    {busy ? 'SETTING UP…' : 'SET UP MY ACCOUNT'}
                  </button>
                  <Link href={signInHref(token)} style={{ fontSize: 13, textAlign: 'center' }}>
                    Already have an account? Sign in
                  </Link>
                </>
              )}
            </div>
          ) : null}

          {stage === 'signed-in' && invitation !== null ? (
            <form
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
              onSubmit={(event) => {
                event.preventDefault();
                void accept();
              }}
            >
              <p style={{ ...lead, margin: 0 }}>
                Signed in as <strong>{signedInAs}</strong>. The invitation is for{' '}
                <strong>{invitation.maskedEmail}</strong>.
              </p>

              {needsPassword ? (
                <>
                  <p style={{ ...lead, margin: 0 }}>
                    Choose a password, so you can sign in again next time.
                  </p>
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

              <button type="submit" className="btn btn-gold btn-block" disabled={busy}>
                {busy ? 'ACCEPTING…' : 'ACCEPT INVITATION'}
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
