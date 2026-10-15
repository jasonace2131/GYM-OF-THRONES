'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthBrandPanel from './AuthBrandPanel';
import { supabase } from '@/lib/supabase';
import { EMAIL_INPUT_PROPS, normaliseIdentifier } from '@/lib/credentials';
import { safeNext } from '@/lib/safeNext';
import { PasswordInput } from './PasswordInput';

interface RegisterFormState {
  fullName: string;
  email: string;
  mobile: string;
  dateOfBirth: string;
  /** Metric, optional. Kept as strings because inputs give strings. */
  heightCm: string;
  weightKg: string;
  password: string;
  confirmPassword: string;
  agreedToWaiver: boolean;
}

const INITIAL_FORM: RegisterFormState = {
  fullName: '',
  email: '',
  mobile: '',
  dateOfBirth: '',
  heightCm: '',
  weightKg: '',
  password: '',
  confirmPassword: '',
  agreedToWaiver: false,
};

export default function RegisterPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // ───────────────────────────────────────────────────────────────────────
  // A DESTINATION IS CARRIED ONLY IF ONE WAS GIVEN.
  //
  // This used to be `safeNext(searchParams.get('next'))`, which turns "no
  // destination" into "/portal/dashboard" and then posted it back to /login
  // on both exits below. Combined with the login screen's own short-circuit,
  // that round trip is what sent admins to the member portal — a misroute
  // with no `?next=` anywhere in the URL the user typed.
  // ───────────────────────────────────────────────────────────────────────
  const requested = searchParams.get('next');
  const loginHref =
    requested === null ? '/login' : `/login?next=${encodeURIComponent(safeNext(requested))}`;
  const [form, setForm] = useState<RegisterFormState>(INITIAL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = <K extends keyof RegisterFormState>(key: K, value: RegisterFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);

    // firstName / lastName / phone ride along in user_metadata. The server
    // reads them from the verified token when it provisions the local user,
    // so no separate profile call is needed on first sign-in.
    const [firstName, ...rest] = form.fullName.trim().split(' ');

    const { error: signUpError } = await supabase.auth.signUp({
      email: normaliseIdentifier(form.email),
      password: form.password,
      options: {
        data: {
          firstName: firstName ?? form.fullName,
          lastName: rest.join(' '),
          // Optional, like height and weight below: sent only when filled in.
          ...(form.mobile.trim() ? { phone: form.mobile.trim() } : {}),
          // Collected since the first version and discarded at every layer:
          // required on the input, absent from this payload, no column. The
          // system could not answer "is this member a minor?" for anybody —
          // including for a waiver a minor cannot legally sign alone.
          dateOfBirth: form.dateOfBirth,
          // Optional — sent only when filled in. The server coerces and
          // range-checks these, so a blank or a typo is discarded rather
          // than stored.
          ...(form.heightCm ? { heightCm: form.heightCm } : {}),
          ...(form.weightKg ? { weightKg: form.weightKg } : {}),
        },
      },
    });

    setSubmitting(false);

    if (signUpError) {
      setError(signUpError.message);
      return;
    }

    /*
     * CONSENT IS RECORDED ON FIRST SIGN-IN, NOT HERE, AND THAT IS FORCED.
     *
     * `signUp` may require email confirmation, so there is frequently no
     * session at this point and therefore no token to authenticate
     * `POST /me/consent` with. There is also no local User row yet —
     * provisioning happens on the first authenticated request.
     *
     * So the checkbox above is an INTENT, and the portal's ConsentGate is
     * what converts it into a record the moment the member actually arrives.
     * Anyone who skips it — a confirmation link opened weeks later, an
     * account made by staff — meets the same gate. That is the whole reason
     * the gate blocks rather than nags.
     */
    router.push(loginHref);
  };

  return (
    <div className="auth-split">
      <AuthBrandPanel
        image="/assets/gym-b.webp"
        imageAlt="Gym training area"
        backLabel="← BACK TO LOGIN"
        onBack={() => router.push(loginHref)}
        headline={['JOIN THE', 'HOUSE OF', 'FITNESS']}
        kicker="Register · Choose a plan · Show up"
        blurb="Join hundreds of members training hard every day. Takes about two minutes."
      />

      {/* Form panel */}
      <div className="auth-form-pane">
        <div style={{ width: '100%', maxWidth: 430, animation: 'fadeInUp .55s ease both' }}>
          {/* Progress — makes the commitment feel finite */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
            <span className="eyebrow" style={{ whiteSpace: 'nowrap' }}>
              Step 1 of 2
            </span>
            <span style={{ flex: 1, height: 3, borderRadius: 2, background: 'var(--line-2)' }}>
              <span
                style={{
                  display: 'block',
                  width: '50%',
                  height: '100%',
                  borderRadius: 2,
                  background: 'linear-gradient(90deg, var(--gold), var(--gold-lit))',
                  boxShadow: '0 0 12px rgba(201,146,42,.6)',
                }}
              />
            </span>
          </div>

          <h1
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: 'clamp(30px, 3.8vw, 42px)',
              letterSpacing: '-0.01em',
              margin: '0 0 8px',
              color: 'var(--text)',
            }}
          >
            CREATE ACCOUNT
          </h1>
          <p
            style={{ fontSize: 14.5, lineHeight: 1.6, color: 'var(--text-2)', margin: '0 0 26px' }}
          >
            Register now, choose a plan, then pay at the counter or via GCash.
          </p>

          <form
            onSubmit={handleSubmit}
            style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
          >
            <div className="field">
              <label htmlFor="reg-fullname">Full name</label>
              <input
                id="reg-fullname"
                className="input"
                placeholder="Juan Dela Cruz"
                value={form.fullName}
                onChange={(e) => setField('fullName', e.target.value)}
                autoComplete="name"
                required
              />
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="reg-email">Email</label>
                <input
                  id="reg-email"
                  className="input"
                  type="email"
                  placeholder="you@example.com"
                  value={form.email}
                  onChange={(e) => setField('email', e.target.value)}
                  autoComplete="email"
                  // The address is normalised on submit too, but stopping the
                  // keyboard adding a space is the half the member can see.
                  {...EMAIL_INPUT_PROPS}
                  required
                />
              </div>
              <div className="field">
                {/* Optional: the gym sends no SMS, so nothing here depends on a
                    number. The desk can still reach a member who leaves one. */}
                <label htmlFor="reg-mobile">
                  Mobile number <span style={{ color: 'var(--text-3)' }}>· optional</span>
                </label>
                <input
                  id="reg-mobile"
                  className="input"
                  type="tel"
                  placeholder="0917 000 0000"
                  value={form.mobile}
                  onChange={(e) => setField('mobile', e.target.value)}
                  autoComplete="tel"
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="reg-dob">Date of birth</label>
              <input
                id="reg-dob"
                className="input"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => setField('dateOfBirth', e.target.value)}
                required
              />
            </div>

            {/* Optional — the account works without them, and they can be
                filled in later from the profile. Not marked required. */}
            <div className="field-row">
              <div className="field">
                <label htmlFor="reg-height">
                  Height (cm) <span style={{ color: 'var(--text-3)' }}>· optional</span>
                </label>
                <input
                  id="reg-height"
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={50}
                  max={260}
                  step="0.1"
                  placeholder="170"
                  value={form.heightCm}
                  onChange={(e) => setField('heightCm', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="reg-weight">
                  Weight (kg) <span style={{ color: 'var(--text-3)' }}>· optional</span>
                </label>
                <input
                  id="reg-weight"
                  className="input"
                  type="number"
                  inputMode="decimal"
                  min={20}
                  max={400}
                  step="0.1"
                  placeholder="70"
                  value={form.weightKg}
                  onChange={(e) => setField('weightKg', e.target.value)}
                />
              </div>
            </div>

            <div className="field-row">
              <div className="field">
                <label htmlFor="reg-password">Password</label>
                <PasswordInput
                  id="reg-password"
                  placeholder="••••••••"
                  value={form.password}
                  onChange={(e) => setField('password', e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
              <div className="field">
                <label htmlFor="reg-confirm-password">Confirm password</label>
                <PasswordInput
                  id="reg-confirm-password"
                  placeholder="••••••••"
                  value={form.confirmPassword}
                  onChange={(e) => setField('confirmPassword', e.target.value)}
                  autoComplete="new-password"
                  required
                />
              </div>
            </div>

            {/*
              This checkbox used to be theatre. It said "I agree to the gym
              rules and waiver", there were no such documents, it was never
              sent anywhere and there was no column to hold it — so a member
              believed they had signed something the gym could not produce.
              It now names the three real documents, links to each, and its
              acceptance is RECORDED by POST /me/consent below. `required`
              remains an HTML nicety; the enforcement is the portal gate.
            */}
            <label className="checkbox-row" style={{ marginTop: 2 }}>
              <input
                id="reg-waiver"
                type="checkbox"
                checked={form.agreedToWaiver}
                onChange={(e) => setField('agreedToWaiver', e.target.checked)}
                required
              />
              <span>
                I have read and agree to the{' '}
                <a href="/waiver" target="_blank" rel="noopener noreferrer">
                  liability waiver
                </a>
                ,{' '}
                <a href="/terms" target="_blank" rel="noopener noreferrer">
                  terms of membership
                </a>{' '}
                and{' '}
                <a href="/privacy" target="_blank" rel="noopener noreferrer">
                  privacy notice
                </a>
                .
              </span>
            </label>

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

            <button
              id="reg-submit-btn"
              type="submit"
              disabled={submitting}
              className="btn btn-gold btn-block btn-auth"
              style={{ marginTop: 4 }}
            >
              {submitting ? 'CREATING ACCOUNT…' : 'CONTINUE TO PLAN'}
              {!submitting && (
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </button>

            <div style={{ fontSize: 13, textAlign: 'center', color: 'var(--text-3)' }}>
              Already a member?{' '}
              <Link href={loginHref}>Sign in</Link>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
