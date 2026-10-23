'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { BMI_UNDERWEIGHT_BELOW, bmiOf, type MyProfile, type MyProfilePatch } from '@got/shared';
import {
  changeEmail,
  changePassword,
  deleteAccount,
  describeSaveFailure,
  getProfile,
  saveProfile,
} from '@/lib/account';
import { updateEmail, updatePassword, verifyCurrentPassword } from '@/lib/accountAuth';
import { ApiError } from '@/lib/api';
import { signOutMember } from '@/lib/memberSignOut';
import { SignOutButton } from '@/components/auth/ConfirmSignOutDialog';
import { ACCOUNT_DELETED_FLAG } from '@/lib/accountDeleted';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { useMe } from '@/components/rbac/MeProvider';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  BodySection,
  DeleteSection,
  DetailsSection,
  EmailSection,
  PasswordSection,
} from '@/components/portal/account/AccountSections';
import './account.css';

/**
 * My account (owner-approved mock, 2026-10-23): a summary first — the ink
 * profile card, Body & health, two tiles and a settings list — and every edit
 * in a sheet (bottom sheet on phones, side panel from 900px).
 *
 * Name, phone, body numbers and notes are ours (`/me/profile`); email and
 * password are Supabase's, changed from the browser on the member's own
 * session. Deleting the account is the API's (`POST /me/delete-account`),
 * offered only when `/me/profile` says this account may (a member).
 *
 * Ungated: every signed-in person has an account to look after. The routes
 * behind it are keyless and hard-coded to the caller.
 */

type SheetKind = 'details' | 'email' | 'body' | 'password' | 'delete';

const SHEET_TITLES: Record<SheetKind, string> = {
  details: 'Edit details',
  email: 'Change email',
  body: 'Body & health',
  password: 'Change password',
  delete: 'Delete account',
};

const SHEET_DESCRIPTIONS: Record<SheetKind, string> = {
  details: 'Your name as the gym knows you, and a phone number to reach you.',
  email: 'We send a confirmation link to both addresses.',
  body: 'Height, weight and medical notes.',
  password: 'Asks for your current one first.',
  delete: 'Your account is deleted straight away.',
};

export default function AccountPage() {
  const router = useRouter();
  const { reload: reloadMe } = useMe();
  const [profile, setProfile] = useState<MyProfile | null>(null);
  /**
   * Why the load failed. Only a request that never got an answer is the
   * connection's fault; an HTTP error (404, 5xx) is ours, and telling the
   * member to check their wifi would send them chasing the wrong thing.
   */
  const [failed, setFailed] = useState<'network' | 'http' | null>(null);
  const [sheet, setSheet] = useState<SheetKind | null>(null);

  const load = useCallback(() => {
    setFailed(null);
    getProfile()
      .then(setProfile)
      .catch((error: unknown) => setFailed(error instanceof ApiError ? 'http' : 'network'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const signOut = useCallback(async () => {
    await signOutMember();
    router.replace('/login');
  }, [router]);

  if (failed !== null) {
    return (
      <Card>
        <EmptyState
          title="Couldn't load your account."
          hint={
            failed === 'network' ? 'Check your connection and try again.' : 'Try again in a moment.'
          }
          action={
            <button type="button" className="p-btn p-btn-dark p-btn-sm" onClick={load}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  if (profile === null) {
    return (
      <div style={{ display: 'grid', gap: 20 }}>
        <Skeleton height={60} />
        <Skeleton height={240} />
        <Skeleton height={280} />
      </div>
    );
  }

  /** A name or phone change also renames the topbar, which reads `/me`. */
  const savedDetails = (saved: MyProfile): void => {
    setProfile(saved);
    reloadMe();
  };

  const deleted = async (): Promise<void> => {
    try {
      window.sessionStorage.setItem(ACCOUNT_DELETED_FLAG, '1');
    } catch {
      // Storage blocked: the notice is a courtesy, the deletion already happened.
    }
    await signOutMember('local');
    router.replace('/');
  };

  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');

  return (
    <div className="acct">
      <header className="acct-hello">
        <p className="acct-eyebrow">Welcome back</p>
        <h1>{fullName || profile.email}</h1>
      </header>

      <ProfileCard
        profile={profile}
        onEditDetails={() => setSheet('details')}
        onChangeEmail={() => setSheet('email')}
      />

      <BodyAndHealth
        profile={profile}
        save={saveProfile}
        onSaved={setProfile}
        onEdit={() => setSheet('body')}
      />

      <Tiles profile={profile} />

      <ul className="acct-list" aria-label="Account settings">
        <li>
          <button type="button" className="acct-li" onClick={() => setSheet('password')}>
            <span className="acct-li-text">
              <b>Change password</b>
              <small>Asks for your current one first</small>
            </span>
            <Chevron />
          </button>
        </li>
        <li>
          {/* The membership terms ARE the policy: billing, grace, freezing,
              cancellation and refunds — app/(legal)/terms. */}
          <Link className="acct-li" href="/terms">
            <span className="acct-li-text">
              <b>Membership policy</b>
              <small>Freezes, grace days, refunds</small>
            </span>
            <Chevron />
          </Link>
        </li>
        <li>
          <SignOutButton surface="member" className="acct-li acct-li-danger" onConfirm={signOut}>
            <span className="acct-li-text">
              <b>Sign out</b>
            </span>
          </SignOutButton>
        </li>
        {profile.canDeleteAccount ? (
          <li>
            <button
              type="button"
              className="acct-li acct-li-danger"
              onClick={() => setSheet('delete')}
            >
              <span className="acct-li-text">
                <b>Delete account</b>
                <small>Erases your personal data for good</small>
              </span>
              <Chevron />
            </button>
          </li>
        ) : null}
      </ul>

      <AccountSheet kind={sheet} onClose={() => setSheet(null)}>
        {sheet === 'details' ? (
          <DetailsSection profile={profile} save={saveProfile} onSaved={savedDetails} />
        ) : null}
        {sheet === 'email' ? (
          <EmailSection
            framed={false}
            email={profile.email}
            change={(next) => changeEmail({ update: updateEmail }, next)}
          />
        ) : null}
        {sheet === 'body' ? (
          <BodySection framed={false} profile={profile} save={saveProfile} onSaved={setProfile} />
        ) : null}
        {sheet === 'password' ? (
          <PasswordSection
            framed={false}
            email={profile.email}
            change={(input) =>
              changePassword({ verify: verifyCurrentPassword, update: updatePassword }, input)
            }
          />
        ) : null}
        {sheet === 'delete' ? (
          <DeleteSection
            profile={profile}
            remove={(password) =>
              deleteAccount({ verify: verifyCurrentPassword }, { email: profile.email, password })
            }
            onDeleted={() => void deleted()}
            onCancel={() => setSheet(null)}
          />
        ) : null}
      </AccountSheet>
    </div>
  );
}

// ── Sheet ─────────────────────────────────────────────────────────────────

function AccountSheet({
  kind,
  onClose,
  children,
}: {
  kind: SheetKind | null;
  onClose: () => void;
  children: ReactNode;
}) {
  const wide = useMediaQuery('(min-width: 900px)');
  return (
    <Sheet
      open={kind !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent
        side={wide ? 'right' : 'bottom'}
        showCloseButton={false}
        className={`acct-sheet ${wide ? 'acct-sheet-side' : 'acct-sheet-bottom'}`}
      >
        {wide ? null : <span aria-hidden className="acct-grab" />}
        <SheetHeader style={{ padding: 0, gap: 4 }}>
          <SheetTitle className="acct-sheet-title">
            {kind === null ? '' : SHEET_TITLES[kind]}
          </SheetTitle>
          <SheetDescription className="acct-sheet-desc">
            {kind === null ? '' : SHEET_DESCRIPTIONS[kind]}
          </SheetDescription>
        </SheetHeader>
        {children}
        {kind === 'delete' ? null : (
          <button type="button" className="p-btn p-btn-ghost acct-sheet-close" onClick={onClose}>
            Close
          </button>
        )}
      </SheetContent>
    </Sheet>
  );
}

// ── Summary pieces ────────────────────────────────────────────────────────

function ProfileCard({
  profile,
  onEditDetails,
  onChangeEmail,
}: {
  profile: MyProfile;
  onEditDetails: () => void;
  onChangeEmail: () => void;
}) {
  const plan = profile.membership;
  return (
    <section className="acct-profile" aria-labelledby="acct-profile-h">
      <div className="acct-profile-head">
        <h2 id="acct-profile-h">YOUR PROFILE</h2>
        {plan === null ? (
          <span className="acct-badge acct-badge-none">No plan</span>
        ) : (
          <span className="acct-badge">
            {plan.planName} · {plan.status}
          </span>
        )}
      </div>
      <dl className="acct-rows">
        <Row label="Email" value={profile.email} />
        <Row label="Phone" value={profile.phone} empty="Not added" />
        <Row label="Member code" value={profile.memberCode} empty="Not issued yet" />
      </dl>
      <div className="acct-profile-actions">
        <button type="button" className="acct-pill" onClick={onEditDetails}>
          Edit details
          <span className="acct-pill-dot" aria-hidden>
            →
          </span>
        </button>
        <button type="button" className="acct-pill-ghost" onClick={onChangeEmail}>
          Change email
        </button>
      </div>
    </section>
  );
}

function Row({ label, value, empty }: { label: string; value: string | null; empty?: string }) {
  return (
    <div className="acct-row">
      <dt>{label}</dt>
      {value === null ? <dd className="acct-unset">{empty}</dd> : <dd>{value}</dd>}
    </div>
  );
}

function BodyAndHealth({
  profile,
  save,
  onSaved,
  onEdit,
}: {
  profile: MyProfile;
  save: (patch: MyProfilePatch) => Promise<MyProfile>;
  onSaved: (profile: MyProfile) => void;
  onEdit: () => void;
}) {
  const bmi = bmiOf(profile.heightCm, profile.weightKg);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const share = profile.shareMedicalWithPlanner;

  /** The switch saves at once — the same PATCH the sheet's checkbox sends. */
  const toggle = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      onSaved(await save({ shareMedicalWithPlanner: !share }));
    } catch (caught) {
      setProblem(describeSaveFailure(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="acct-body-area" aria-labelledby="acct-body-h">
      <h2 id="acct-body-h" className="acct-sect-h">
        Body &amp; <em>health</em>
      </h2>
      <div className="acct-card">
        <dl className="acct-stats">
          <Stat unit="cm" value={profile.heightCm === null ? '—' : String(profile.heightCm)} />
          <Stat unit="kg" value={profile.weightKg === null ? '—' : String(profile.weightKg)} />
          <Stat unit="BMI" value={bmi === null ? '—' : bmi.toFixed(1)} />
        </dl>
        {bmi !== null && bmi < BMI_UNDERWEIGHT_BELOW ? (
          <span className="acct-chip">Under 18.5 · &quot;Lose fat&quot; is hidden in the planner</span>
        ) : null}
        <div className="acct-note">
          <h3>Medical notes</h3>
          {profile.medicalNotes === null ? (
            <p className="acct-unset">No notes</p>
          ) : (
            <p>{profile.medicalNotes}</p>
          )}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={share}
          aria-describedby="acct-share-help"
          className="acct-toggle"
          disabled={busy}
          onClick={() => void toggle()}
        >
          <span className="acct-switch" aria-hidden />
          <span className="acct-toggle-text">
            <b>Workout planner can use my notes</b>
            <small id="acct-share-help">
              {share
                ? 'On: the AI that writes your plans reads them to avoid exercises that could hurt you.'
                : 'Off: they stay on your account and the AI never sees them.'}
            </small>
          </span>
        </button>
        {problem === null ? null : (
          <p role="alert" className="acct-msg acct-msg-bad">
            {problem}
          </p>
        )}
        <div className="acct-actions">
          <button type="button" className="acct-btn" onClick={onEdit}>
            Edit body &amp; health
          </button>
        </div>
      </div>
    </section>
  );
}

function Stat({ value, unit }: { value: string; unit: string }) {
  return (
    <div className="acct-stat">
      <dt>{unit}</dt>
      <dd>{value}</dd>
    </div>
  );
}

const DAY_MONTH = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

function Tiles({ profile }: { profile: MyProfile }) {
  const plan = profile.membership;
  let membershipLine = 'No plan yet — see the plans';
  if (plan !== null) {
    const until = DAY_MONTH.format(new Date(`${plan.endsOn}T00:00:00Z`));
    membershipLine =
      plan.status === 'ACTIVE'
        ? `${plan.planName} · ${plan.daysLeft} ${plan.daysLeft === 1 ? 'day' : 'days'} left · until ${until}`
        : `${plan.planName} · ${plan.status.toLowerCase()} · ended ${until}`;
  }
  return (
    <div className="acct-tiles">
      <Link className="acct-tile" href="/portal/subscription">
        <span className="acct-ico" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="5" width="18" height="14" rx="2" />
            <path d="M3 10h18" />
          </svg>
        </span>
        <h3>Membership</h3>
        <p>{membershipLine}</p>
        <span className="acct-go">→ Manage</span>
      </Link>
      <Link className="acct-tile" href="/portal/pay">
        <span className="acct-ico" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7h16v10H4z" />
            <path d="M8 12h8" />
          </svg>
        </span>
        <h3>Payments</h3>
        <p>GCash receipts and their status</p>
        <span className="acct-go">→ View</span>
      </Link>
    </div>
  );
}

function Chevron() {
  return (
    <span className="acct-chev" aria-hidden>
      ›
    </span>
  );
}
