'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import AuthBrandPanel from './AuthBrandPanel';
import { supabase } from '@/lib/supabase';
import {
  MINIMUM_AGE_MESSAGE,
  PROFILE_LIMITS,
  collapseSpaces,
  isPersonName,
  isPlausibleBirthDate,
  meetsMinimumAge,
  normalisePhPhone,
} from '@got/shared';
import { normaliseIdentifier, normalisePassword } from '@/lib/credentials';
import { GYM_TIMEZONE, gymToday } from '@/lib/gymTime';
import { filterDecimalTyping, parseDecimalField } from '@/lib/numberInput';
import { BirthDateInput } from '@/components/inputs/BirthDateInput';
import { EmailInput } from '@/components/inputs/EmailInput';
import { NameInput } from '@/components/inputs/NameInput';
import { PhoneInput } from '@/components/inputs/PhoneInput';
import { type HeldPermission, destinationFor, safeNext } from '@/lib/safeNext';
import { apiFetch } from '@/lib/api';
import { classifyMeFailure } from '@/lib/loginCode';
import { newPasswordProblem, passwordRefusalMessage } from '@/lib/passwordRules';
import { NewPasswordFields } from './NewPasswordFields';

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
  /** The password was refused: the rules still unmet show as missing, not "to do". */
  const [passwordTried, setPasswordTried] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  /** True until we know nobody is already signed in on this browser. */
  const [checking, setChecking] = useState(true);

  // ALREADY SIGNED IN (2026-10-23): this browser has an account, so route it
  // on exactly as /login would rather than offering a second sign-up. A
  // sign-in still owed its emailed code goes to /login, which shows the code
  // step (/register is exempt from apiFetch's own redirect so the choice is
  // made here). A sign-up the API refused as under 12 is signed out, with the
  // reason over the form. Any other failure shows the form; nobody is signed out.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let token: string | undefined;
      try {
        const { data } = await supabase.auth.getSession();
        token = data.session?.access_token;
      } catch {
        token = undefined;
      }
      if (cancelled) return;
      if (!token) {
        setChecking(false);
        return;
      }
      try {
        const me = await apiFetch<{ permissions: HeldPermission[] }>('/me', {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!cancelled) router.replace(destinationFor(requested, me.permissions));
      } catch (caught) {
        if (cancelled) return;
        const failure = classifyMeFailure(caught);
        if (failure === 'code-required') {
          router.replace(loginHref);
          return;
        }
        if (failure === 'too-young') {
          try {
            await supabase.auth.signOut();
          } catch {
            // The form is the right place either way.
          }
          if (cancelled) return;
          setError(MINIMUM_AGE_MESSAGE);
        }
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Mount only: where to go is decided once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setField = <K extends keyof RegisterFormState>(key: K, value: RegisterFormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const fullName = collapseSpaces(form.fullName);
    if (!isPersonName(fullName, 2)) {
      setError("Enter your name — letters, spaces, apostrophes ('), hyphens (-) and dots only.");
      return;
    }
    const phone = form.mobile.trim() === '' ? null : normalisePhPhone(form.mobile);
    if (form.mobile.trim() !== '' && phone === null) {
      setError('Enter a PH mobile number — 09XX XXX XXXX or +63 9XX XXX XXXX — or leave it blank.');
      return;
    }
    const today = gymToday(new Date(), GYM_TIMEZONE);
    if (!isPlausibleBirthDate(form.dateOfBirth, today)) {
      setError('Enter your real date of birth — it cannot be in the future.');
      return;
    }
    // Owner, 2026-10-30. Checked here so a child is never sent to Supabase at
    // all; the API refuses the account on first sight as well.
    if (!meetsMinimumAge(form.dateOfBirth, today)) {
      setError(MINIMUM_AGE_MESSAGE);
      return;
    }
    const L = PROFILE_LIMITS;
    if (
      form.heightCm !== '' &&
      parseDecimalField(form.heightCm, L.heightCmMin, L.heightCmMax, 1) === null
    ) {
      setError(`Height is ${L.heightCmMin}–${L.heightCmMax} cm — or leave it blank.`);
      return;
    }
    if (
      form.weightKg !== '' &&
      parseDecimalField(form.weightKg, L.weightKgMin, L.weightKgMax, 1) === null
    ) {
      setError(`Weight is ${L.weightKgMin}–${L.weightKgMax} kg — or leave it blank.`);
      return;
    }
    const passwordProblem = newPasswordProblem(form.password, form.confirmPassword);
    if (passwordProblem !== null) {
      setError(passwordProblem);
      setPasswordTried(true);
      return;
    }

    setSubmitting(true);

    // firstName / lastName / phone ride along in user_metadata. The server
    // reads them from the verified token when it provisions the local user,
    // so no separate profile call is needed on first sign-in.
    // First word is the first name, the rest the last name ("Juan Dela Cruz").
    const [firstName, ...rest] = fullName.split(' ');

    const { error: signUpError } = await supabase.auth.signUp({
      email: normaliseIdentifier(form.email),
      // Cleaned exactly as sign-in cleans it, or a pasted invisible character
      // would be saved here and stripped there — a password that never works.
      password: normalisePassword(form.password),
      options: {
        data: {
          firstName: firstName ?? fullName,
          lastName: rest.join(' '),
          // Optional, like height and weight below: sent only when filled in.
          ...(phone !== null ? { phone } : {}),
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
      setError(passwordRefusalMessage(signUpError));
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

          {checking ? (
            <p role="status" style={{ fontSize: 14, color: 'var(--text-2)', margin: 0 }}>
              Checking your sign-in…
            </p>
          ) : (
            <form
              onSubmit={handleSubmit}
              style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
            >
              <div className="field">
                <label htmlFor="reg-fullname">Full name</label>
                <NameInput
                  id="reg-fullname"
                  className="input"
                  placeholder="Juan Dela Cruz"
                  value={form.fullName}
                  onChange={(value) => setField('fullName', value)}
                  autoComplete="name"
                  required
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label htmlFor="reg-email">Email</label>
                  {/* The address is normalised on submit too, but stopping the
                    keyboard adding a space is the half the member can see. */}
                  <EmailInput
                    id="reg-email"
                    className="input"
                    placeholder="you@example.com"
                    value={form.email}
                    onChange={(value) => setField('email', value)}
                    required
                  />
                </div>
                <div className="field">
                  {/* Optional: the gym sends no SMS, so nothing here depends on a
                    number. The desk can still reach a member who leaves one. */}
                  <label htmlFor="reg-mobile">
                    Mobile number <span style={{ color: 'var(--text-3)' }}>· optional</span>
                  </label>
                  <PhoneInput
                    id="reg-mobile"
                    className="input"
                    placeholder="0917 000 0000"
                    value={form.mobile}
                    onChange={(value) => setField('mobile', value)}
                  />
                </div>
              </div>

              <div className="field">
                <label htmlFor="reg-dob">Date of birth</label>
                <BirthDateInput
                  id="reg-dob"
                  className="input"
                  today={gymToday(new Date(), GYM_TIMEZONE)}
                  value={form.dateOfBirth}
                  onChange={(value) => setField('dateOfBirth', value)}
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
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="170"
                    value={form.heightCm}
                    onChange={(e) => setField('heightCm', filterDecimalTyping(e.target.value, 1))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="reg-weight">
                    Weight (kg) <span style={{ color: 'var(--text-3)' }}>· optional</span>
                  </label>
                  <input
                    id="reg-weight"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="70"
                    value={form.weightKg}
                    onChange={(e) => setField('weightKg', filterDecimalTyping(e.target.value, 1))}
                  />
                </div>
              </div>

              {/* Stacked, not side by side: the checklist sits under the password. */}
              <NewPasswordFields
                password={form.password}
                confirm={form.confirmPassword}
                onPasswordChange={(value) => setField('password', value)}
                onConfirmChange={(value) => setField('confirmPassword', value)}
                labels={{ password: 'Password', confirm: 'Confirm password' }}
                names={{ password: 'password', confirm: 'confirmPassword' }}
                placeholder="••••••••"
                showMissing={passwordTried}
                disabled={submitting}
              />

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
                Already a member? <Link href={loginHref}>Sign in</Link>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
