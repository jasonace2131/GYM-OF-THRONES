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
 * My account — layout A, "account hub" (owner's pick, 2026-10-26; replaces the
 * 1040px two-column mock of 2026-10-23, which left half a wide screen empty).
 * A summary that uses the whole width — the ink profile band, Body & health
 * beside Sign-in & security, then three tiles — and every edit in a sheet
 * (bottom sheet on phones, side panel from 900px).
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

  return (
    <div className="acct">
      <div className="acct-grid">
        <ProfileBand
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

        <section className="acct-sec" aria-labelledby="acct-sec-h">
          <h2 id="acct-sec-h" className="acct-card-h">
            <CardIcon d={ICONS.shield} />
            Sign-in &amp; security
          </h2>
          <ul className="acct-list">
            <li>
              <button type="button" className="acct-li" onClick={() => setSheet('password')}>
                <RowIcon d={ICONS.lock} />
                <span className="acct-li-text">
                  <b>Change password</b>
                  <small>Asks for your current one first</small>
                </span>
                <Chevron />
              </button>
            </li>
            <li>
              <button type="button" className="acct-li" onClick={() => setSheet('email')}>
                <RowIcon d={ICONS.mail} />
                <span className="acct-li-text">
                  <b>Change email</b>
                  <small>A confirmation link goes to both addresses</small>
                </span>
                <Chevron />
              </button>
            </li>
            <li>
              <SignOutButton
                surface="member"
                className="acct-li acct-li-danger"
                onConfirm={signOut}
              >
                <RowIcon d={ICONS.signOut} />
                <span className="acct-li-text">
                  <b>Sign out</b>
                  <small>On this device</small>
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
                  <RowIcon d={ICONS.trash} />
                  <span className="acct-li-text">
                    <b>Delete account</b>
                    <small>Erases your personal data for good</small>
                  </span>
                  <Chevron />
                </button>
              </li>
            ) : null}
          </ul>
        </section>

        <Tiles profile={profile} />
      </div>

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

/** Single-path stroke icons, 24-unit box. Decorative: every one sits beside its words. */
const ICONS = {
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  pulse: 'M3 12h4l3-8 4 16 3-8h4',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6Z',
  lock: 'M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4',
  mail: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 7l9 6 9-6',
  signOut: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  card: 'M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18',
  receipt: 'M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2ZM9 8h6M9 12h6',
  doc: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9ZM14 3v6h6M8 13h8M8 17h5',
} as const;

function Icon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}

/** The gold-on-cream square beside a card's heading. */
function CardIcon({ d }: { d: string }) {
  return (
    <span className="acct-card-ico" aria-hidden>
      <Icon d={d} />
    </span>
  );
}

function RowIcon({ d }: { d: string }) {
  return (
    <span className="acct-li-ico" aria-hidden>
      <Icon d={d} />
    </span>
  );
}

function Chevron() {
  return (
    <span className="acct-chev" aria-hidden>
      <Icon d="m9 18 6-6-6-6" />
    </span>
  );
}

/** "JD" for Juan Dela Cruz; the email's first letter when no name is on file. */
function initialsOf(profile: MyProfile): string {
  const first = (word: string): string => Array.from(word.trim())[0] ?? '';
  const fromName = `${first(profile.firstName)}${first(profile.lastName)}`;
  return (fromName === '' ? first(profile.email) : fromName).toUpperCase();
}

function ProfileBand({
  profile,
  onEditDetails,
  onChangeEmail,
}: {
  profile: MyProfile;
  onEditDetails: () => void;
  onChangeEmail: () => void;
}) {
  const plan = profile.membership;
  const fullName = [profile.firstName, profile.lastName].filter(Boolean).join(' ');
  return (
    <section className="acct-band" aria-label="Your profile">
      <span className="acct-ring" aria-hidden />
      <div className="acct-id">
        <span className="acct-avatar" aria-hidden>
          {initialsOf(profile)}
        </span>
        <div className="acct-id-text">
          <p className="acct-hello">Welcome back</p>
          <h1>{fullName || profile.email}</h1>
          {plan === null ? (
            <span className="acct-badge acct-badge-none">No plan</span>
          ) : (
            <span className="acct-badge">
              {plan.planName} · {plan.status}
            </span>
          )}
        </div>
      </div>
      <dl className="acct-facts">
        <Fact label="Email" value={profile.email} />
        <Fact label="Phone" value={profile.phone} empty="Not added" />
        <Fact label="Member code" value={profile.memberCode} empty="Not issued yet" />
      </dl>
      <div className="acct-band-actions">
        <button type="button" className="acct-pill" onClick={onEditDetails}>
          Edit details
          <span className="acct-pill-dot" aria-hidden>
            <Icon d={ICONS.pencil} />
          </span>
        </button>
        <button type="button" className="acct-pill-ghost" onClick={onChangeEmail}>
          Change email
        </button>
      </div>
    </section>
  );
}

function Fact({ label, value, empty }: { label: string; value: string | null; empty?: string }) {
  return (
    <div className="acct-fact">
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
    <section className="acct-body" aria-labelledby="acct-body-h">
      <div className="acct-card-head">
        <h2 id="acct-body-h" className="acct-card-h">
          <CardIcon d={ICONS.pulse} />
          Body &amp; health
        </h2>
        <button type="button" className="acct-btn" onClick={onEdit}>
          Edit body &amp; health
        </button>
      </div>
      <div className="acct-body-cols">
        <div className="acct-body-col">
          <dl className="acct-stats">
            <Stat unit="cm" value={profile.heightCm === null ? '—' : String(profile.heightCm)} />
            <Stat unit="kg" value={profile.weightKg === null ? '—' : String(profile.weightKg)} />
            <Stat unit="BMI" value={bmi === null ? '—' : bmi.toFixed(1)} />
          </dl>
          {bmi !== null && bmi < BMI_UNDERWEIGHT_BELOW ? (
            <p className="acct-chip">
              BMI under 18.5, so “Lose fat” is hidden in the workout planner.
            </p>
          ) : null}
        </div>
        <div className="acct-body-col">
          <div className="acct-note">
            <h3>Medical notes</h3>
            {profile.medicalNotes === null ? (
              <p className="acct-unset">
                No notes yet. Add injuries or conditions your coach and planner should work
                around.
              </p>
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

/** ACTIVE → "Active", for the headline of a plan that is not running. */
function statusWord(status: string): string {
  const lower = status.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

function MembershipTileBody({ plan }: { plan: MyProfile['membership'] }) {
  if (plan === null) {
    return (
      <>
        <b className="acct-tile-big">No plan yet</b>
        <p>A plan opens class booking, Workouts and My Coach.</p>
      </>
    );
  }
  const until = DAY_MONTH.format(new Date(`${plan.endsOn}T00:00:00Z`));
  if (plan.status === 'ACTIVE') {
    return (
      <>
        <span className="acct-tile-line">
          <b className="acct-tile-big acct-tile-num">{plan.daysLeft}</b>
          <span className="acct-tile-unit">
            {plan.daysLeft === 1 ? 'day' : 'days'} left on {plan.planName}
          </span>
        </span>
        <p>Active until {until}.</p>
      </>
    );
  }
  return (
    <>
      <b className="acct-tile-big">{statusWord(plan.status)}</b>
      <p>
        {plan.planName} · {plan.status.toLowerCase()} · ended {until}
      </p>
    </>
  );
}

function Tiles({ profile }: { profile: MyProfile }) {
  return (
    <div className="acct-tiles">
      <Link className="acct-tile" href="/portal/subscription">
        <div className="acct-tile-head">
          <h3>
            <CardIcon d={ICONS.card} />
            Membership
          </h3>
          <span className="acct-go">{profile.membership === null ? 'See plans' : 'Manage'}</span>
        </div>
        <MembershipTileBody plan={profile.membership} />
      </Link>
      <Link className="acct-tile" href="/portal/pay">
        <div className="acct-tile-head">
          <h3>
            <CardIcon d={ICONS.receipt} />
            Payments
          </h3>
          <span className="acct-go">View</span>
        </div>
        <b className="acct-tile-big">GCash receipts</b>
        <p>Every receipt you sent and its status.</p>
      </Link>
      {/* The membership terms ARE the policy: billing, grace, freezing,
          cancellation and refunds — app/(legal)/terms. */}
      <Link className="acct-tile" href="/terms">
        <div className="acct-tile-head">
          <h3>
            <CardIcon d={ICONS.doc} />
            Membership policy
          </h3>
          <span className="acct-go">Read</span>
        </div>
        <b className="acct-tile-big">Freezes and refunds</b>
        <p>Grace days, freezing your plan and getting money back.</p>
      </Link>
    </div>
  );
}
