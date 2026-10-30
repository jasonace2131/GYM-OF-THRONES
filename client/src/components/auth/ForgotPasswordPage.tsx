'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AuthBrandPanel from './AuthBrandPanel';
import { supabase } from '@/lib/supabase';
import { EMAIL_INPUT_PROPS, normaliseIdentifier } from '@/lib/credentials';
import { EMAIL_MAX } from '@got/shared';

/**
 * Password recovery, step one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * "FORGOT PASSWORD?" WAS A DEAD `href="#"` FOR THE WHOLE OF DEVELOPMENT.
 *
 * The link sat under every sign-in form and did nothing, so a member who
 * forgot their password had exactly one recovery path: walk to the gym and
 * ask staff to re-send an invite — which only works for someone who has
 * never signed in. This is that gap closed.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ALWAYS REPORTS SUCCESS, even for an address with no account. Saying "no
 * such user" turns this form into a membership oracle: type addresses, learn
 * who trains here. Supabase behaves the same way for the same reason.
 */
export default function ForgotPasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await supabase.auth.resetPasswordForEmail(normaliseIdentifier(email), {
        // Supabase appends the recovery token; `detectSessionInUrl` on the
        // browser client turns it into a session when that page mounts.
        redirectTo: `${window.location.origin}/reset-password`,
      });
      setSent(true);
    } catch {
      // Only a transport failure reaches here — an unknown address is a
      // success by design (see the header).
      setError('We could not reach the mail service. Check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
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
            RESET PASSWORD
          </h1>

          {sent ? (
            <>
              <p
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  margin: '0 0 30px',
                }}
              >
                If an account exists for <strong>{email}</strong>, a reset link is on its way. The
                link expires after a short while — request another if it does.
              </p>
              <Link href="/login" className="btn btn-gold btn-block btn-auth">
                BACK TO SIGN IN
              </Link>
            </>
          ) : (
            <>
              <p
                style={{
                  fontSize: 14.5,
                  lineHeight: 1.6,
                  color: 'var(--text-2)',
                  margin: '0 0 30px',
                }}
              >
                Enter the email on your account and we will send a link to set a new password.
              </p>

              <form
                onSubmit={handleSubmit}
                style={{ display: 'flex', flexDirection: 'column', gap: 18 }}
              >
                <div className="field">
                  <label htmlFor="forgot-email">Email</label>
                  <input
                    id="forgot-email"
                    className="input"
                    type="email"
                    placeholder="you@example.com"
                    maxLength={EMAIL_MAX}
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    autoComplete="email"
                    {...EMAIL_INPUT_PROPS}
                    required
                  />
                </div>

                {error !== null && (
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

                <button
                  type="submit"
                  className="btn btn-gold btn-block btn-auth"
                  style={{ marginTop: 4 }}
                  disabled={submitting}
                >
                  {submitting ? 'SENDING…' : 'SEND RESET LINK'}
                </button>

                <Link href="/login" style={{ fontSize: 13, textAlign: 'center' }}>
                  Back to sign in
                </Link>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
