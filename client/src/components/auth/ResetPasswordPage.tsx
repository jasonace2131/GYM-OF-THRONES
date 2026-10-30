'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AuthBrandPanel from './AuthBrandPanel';
import { supabase } from '@/lib/supabase';
import { normalisePassword } from '@/lib/credentials';
import {
  meetsPasswordRules,
  newPasswordProblem,
  passwordRefusalMessage,
} from '@/lib/passwordRules';
import { NewPasswordFields } from './NewPasswordFields';

/**
 * Password recovery, step two — the page the emailed link lands on.
 *
 * The browser Supabase client is created with `detectSessionInUrl: true`
 * (`lib/supabase.ts`), so arriving here with a recovery token in the URL
 * fragment establishes a short-lived session before this component mounts.
 * `updateUser` then works without the old password, which is the whole point
 * of a reset.
 *
 * WITHOUT that session there is nothing to update — a member who opens this
 * URL directly, or whose link has expired, must be told to request another
 * rather than shown a form that can only fail.
 */
export default function ResetPasswordPage() {
  const router = useRouter();
  const [ready, setReady] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** A save was refused: the rules still unmet show as missing, not "to do". */
  const [tried, setTried] = useState(false);
  /** The field the shown error is about, marked invalid. */
  const [badField, setBadField] = useState<'password' | 'confirm' | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let cancelled = false;

    // The token may still be in flight when this mounts, so listen as well as
    // read: PASSWORD_RECOVERY fires once the fragment has been consumed.
    const { data: subscription } = supabase.auth.onAuthStateChange((event) => {
      if (!cancelled && (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN')) setReady(true);
    });

    void supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) setReady((current) => current ?? data.session !== null);
    });

    return () => {
      cancelled = true;
      subscription.subscription.unsubscribe();
    };
  }, []);

  /** Typing again answers the refusal: it goes, as on every other password screen. */
  const edited =
    (setter: (value: string) => void) =>
    (value: string): void => {
      setter(value);
      setError(null);
      setBadField(null);
    };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const next = normalisePassword(password);

    const problem = newPasswordProblem(next, confirm);
    if (problem !== null) {
      setError(problem);
      setBadField(meetsPasswordRules(next) ? 'confirm' : 'password');
      setTried(true);
      return;
    }

    setSubmitting(true);
    setError(null);
    setBadField(null);
    const { error: failed } = await supabase.auth.updateUser({ password: next });
    setSubmitting(false);

    if (failed !== null) {
      setError(passwordRefusalMessage(failed));
      setBadField('password');
      return;
    }
    setDone(true);
  };

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-e.webp"
        imageAlt="Gym floor"
        backLabel="← BACK TO SIGN IN"
        onBack={() => router.push('/login')}
        headline={['WHERE', 'CHAMPIONS', 'TRAIN']}
        kicker="House of Fitness · Est 2023"
        blurb="Your premier fitness destination equipment, coaching, and community."
      />

      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 400, animation: 'fadeInUp .55s ease both' }}>
          <span className="eyebrow">Account recovery</span>

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
            NEW PASSWORD
          </h1>

          {done ? (
            <>
              <p
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  margin: '0 0 30px',
                }}
              >
                Your password is updated. Sign in with the new one.
              </p>
              <Link href="/login" className="btn btn-gold btn-block btn-auth">
                GO TO SIGN IN
              </Link>
            </>
          ) : ready === false ? (
            <>
              <p
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  margin: '0 0 30px',
                }}
              >
                This reset link is expired or already used. Request a new one — links are
                deliberately short-lived.
              </p>
              <Link href="/forgot-password" className="btn btn-gold btn-block btn-auth">
                REQUEST A NEW LINK
              </Link>
            </>
          ) : (
            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
            >
              <p
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  margin: '0 0 12px',
                }}
              >
                Choose a new password for your account.
              </p>

              <NewPasswordFields
                password={password}
                confirm={confirm}
                onPasswordChange={edited(setPassword)}
                onConfirmChange={edited(setConfirm)}
                labels={{ password: 'New password', confirm: 'Confirm new password' }}
                names={{ password: 'password', confirm: 'confirm' }}
                placeholder="••••••••"
                showMissing={tried}
                disabled={submitting}
                invalid={badField}
                problemId="reset-problem"
              />

              {error !== null && (
                <div
                  id="reset-problem"
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

              <button
                type="submit"
                className="btn btn-gold btn-block btn-auth"
                style={{ marginTop: 4 }}
                disabled={submitting || ready !== true}
              >
                {submitting ? 'SAVING…' : 'SET NEW PASSWORD'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
