'use client';

import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import {
  EMAIL_MAX,
  PH_PHONE_MAX_INPUT,
  PROFILE_LIMITS,
  filterNameTyping,
  filterPhoneTyping,
  type MyProfile,
  type MyProfilePatch,
} from '@got/shared';
import { filterDecimalTyping } from '@/lib/numberInput';
import { CharCounter } from '@/components/inputs/CharCounter';
import {
  ACCOUNT_COPY,
  bodyForm,
  bodyPatch,
  bodySavedMessage,
  describeSaveFailure,
  emailProblem,
  passwordIssue,
  type BodyField,
  type BodyForm,
  type Outcome,
  type PasswordField,
  detailsForm,
  detailsPatch,
  deletePlanWarning,
  type DetailsField,
  type DetailsForm,
} from '@/lib/account';
import { EMAIL_INPUT_PROPS } from '@/lib/credentials';
import { Card, CardHead } from '@/components/portal/ui';
import { NewPasswordFields } from '@/components/auth/NewPasswordFields';
import { PasswordInput } from '@/components/auth/PasswordInput';

/**
 * The three sections of My account. Every decision — what is sent, whether
 * it may be saved, what the member is told — is in `lib/account.ts`; these
 * hold the strings a person types and show the answer under the section.
 *
 * A field's problem appears when the member leaves the field or presses Save
 * — never on every keystroke, which a screen reader would announce letter by
 * letter. The field is then `aria-invalid` and points at its message.
 *
 * Legacy `.p-*` / `.a-*` markup only: this folder is not Tailwind-scanned.
 * The Save buttons are `p-btn-dark`, not the gradient gold.
 */

const field: CSSProperties = { display: 'grid', gap: 5, minWidth: 0 };
const pair: CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 12 };
const half: CSSProperties = { ...field, flex: '1 1 130px' };
const form: CSSProperties = { display: 'grid', gap: 14 };
const errorText: CSSProperties = { color: 'var(--p-danger)', fontSize: 13, margin: 0 };

function Label({ children }: { children: ReactNode }) {
  return <span className="a-person-sub">{children}</span>;
}

/** The answer under a section: a status for success, an alert for a problem. */
function Result({ outcome, id }: { outcome: Outcome | null; id?: string }) {
  if (outcome === null) return null;
  return outcome.ok ? (
    <p id={id} role="status" style={{ color: 'var(--p-ok)', fontSize: 13.5, margin: 0 }}>
      {outcome.message}
    </p>
  ) : (
    <p id={id} role="alert" style={{ ...errorText, fontSize: 13.5 }}>
      {outcome.message}
    </p>
  );
}

/** One field's own problem, linked from the field by `aria-describedby`. */
function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message === undefined ? null : (
    <span id={id} role="alert" style={errorText}>
      {message}
    </span>
  );
}

/** `aria-invalid` + `aria-describedby` for a field with a shown problem, else nothing. */
function invalidProps(message: string | undefined, id: string) {
  return message === undefined ? {} : { 'aria-invalid': true, 'aria-describedby': id };
}

/**
 * A card with its own heading — or, `framed={false}`, just the form: inside a
 * sheet the sheet's title is the heading (My account redesign, 2026-10-23).
 */
function Section({
  title,
  framed = true,
  children,
}: {
  title: string;
  framed?: boolean;
  children: ReactNode;
}) {
  if (!framed) return <>{children}</>;
  return (
    <Card padded={false}>
      <CardHead title={title} as="h2" />
      <div className="p-card-pad">{children}</div>
    </Card>
  );
}

// ── Body & health ──────────────────────────────────────────────────────────

export function BodySection({
  profile,
  save,
  onSaved,
  framed = true,
}: {
  profile: MyProfile;
  save: (patch: MyProfilePatch) => Promise<MyProfile>;
  onSaved: (profile: MyProfile) => void;
  framed?: boolean;
}) {
  const uid = useId();
  const [values, setValues] = useState<BodyForm>(() => bodyForm(profile));
  const [touched, setTouched] = useState<ReadonlySet<BodyField>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const { patch, problems, problem } = bodyPatch(profile, values);
  const original = bodyForm(profile);
  const dirty =
    values.height !== original.height ||
    values.weight !== original.weight ||
    values.notes !== original.notes ||
    values.share !== original.share;
  const shown = (key: BodyField): string | undefined =>
    submitted || touched.has(key) ? problems[key] : undefined;
  const errorId = (key: BodyField): string => `${uid}-${key}-error`;

  const set = (key: 'height' | 'weight' | 'notes') => (event: { target: { value: string } }) => {
    // Height and weight: digits and one decimal place — no e, + or -.
    const raw = event.target.value;
    setValues({ ...values, [key]: key === 'notes' ? raw : filterDecimalTyping(raw, 1) });
    setOutcome(null);
  };
  const leave = (key: BodyField) => () => setTouched(new Set(touched).add(key));

  const submit = async (): Promise<void> => {
    setSubmitted(true);
    if (problem !== null || Object.keys(patch).length === 0) return;
    setBusy(true);
    setOutcome(null);
    try {
      const saved = await save(patch);
      onSaved(saved);
      setValues(bodyForm(saved));
      setTouched(new Set());
      setSubmitted(false);
      setOutcome({ ok: true, message: bodySavedMessage(saved) });
    } catch (caught) {
      setOutcome({ ok: false, message: describeSaveFailure(caught) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title="Body & health" framed={framed}>
      <form
        style={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <p className="p-muted" style={{ margin: 0 }}>
          Your height and weight are your current numbers for your coach and the workout planner.
          Medical notes are private: they are never shown at the front desk.
        </p>
        <div style={pair}>
          <label style={half}>
            <Label>HEIGHT (CM)</Label>
            <input
              className="a-input"
              name="heightCm"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="175"
              value={values.height}
              disabled={busy}
              onChange={set('height')}
              onBlur={leave('height')}
              {...invalidProps(shown('height'), errorId('height'))}
            />
            <FieldError id={errorId('height')} message={shown('height')} />
          </label>
          <label style={half}>
            <Label>WEIGHT (KG)</Label>
            <input
              className="a-input"
              name="weightKg"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              placeholder="72.5"
              value={values.weight}
              disabled={busy}
              onChange={set('weight')}
              onBlur={leave('weight')}
              {...invalidProps(shown('weight'), errorId('weight'))}
            />
            <FieldError id={errorId('weight')} message={shown('weight')} />
          </label>
        </div>
        <label style={field}>
          <Label>MEDICAL NOTES — OPTIONAL</Label>
          <textarea
            className="a-textarea"
            name="medicalNotes"
            rows={4}
            maxLength={PROFILE_LIMITS.medicalNotesMax}
            placeholder="Injuries or conditions, e.g. bad left knee, no overhead pressing"
            value={values.notes}
            disabled={busy}
            onChange={set('notes')}
            onBlur={leave('notes')}
            style={{ resize: 'vertical' }}
            aria-describedby={`${uid}-notes-count`}
            {...invalidProps(shown('notes'), errorId('notes'))}
          />
          <CharCounter
            id={`${uid}-notes-count`}
            value={values.notes}
            max={PROFILE_LIMITS.medicalNotesMax}
          />
          <FieldError id={errorId('notes')} message={shown('notes')} />
        </label>
        <label style={{ display: 'grid', gridTemplateColumns: 'auto minmax(0,1fr)', gap: 10 }}>
          <input
            type="checkbox"
            name="shareMedicalWithPlanner"
            checked={values.share}
            disabled={busy}
            aria-describedby={`${uid}-share-help`}
            onChange={(event) => {
              setValues({ ...values, share: event.target.checked });
              setOutcome(null);
            }}
            style={{ width: 18, height: 18, marginTop: 2, accentColor: 'var(--gold)' }}
          />
          <span style={{ display: 'grid', gap: 3 }}>
            <span style={{ fontSize: 14.5, fontWeight: 500 }}>{ACCOUNT_COPY.shareLabel}</span>
            <span id={`${uid}-share-help`} className="p-muted" style={{ fontSize: 12.5 }}>
              {ACCOUNT_COPY.shareHelper}
            </span>
          </span>
        </label>
        <Result outcome={outcome} />
        <div>
          <button type="submit" className="p-btn p-btn-dark" disabled={busy || !dirty}>
            {busy ? 'Saving…' : 'Save body & health'}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ── Email ──────────────────────────────────────────────────────────────────

export function EmailSection({
  email,
  change,
  framed = true,
}: {
  email: string;
  change: (next: string) => Promise<Outcome>;
  framed?: boolean;
}) {
  const uid = useId();
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const resultId = `${uid}-result`;

  const submit = async (): Promise<void> => {
    const problem = emailProblem(email, next);
    if (problem !== null) {
      setOutcome({ ok: false, message: problem });
      return;
    }
    setBusy(true);
    setOutcome(null);
    const result = await change(next);
    setBusy(false);
    setOutcome(result);
    if (result.ok) setNext('');
  };

  return (
    <Section title="Email" framed={framed}>
      <form
        style={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div style={field}>
          <Label>CURRENT EMAIL</Label>
          <span style={{ fontSize: 15, overflowWrap: 'anywhere' }}>{email}</span>
        </div>
        <label style={field}>
          <Label>NEW EMAIL</Label>
          <input
            className="a-input"
            name="email"
            type="email"
            autoComplete="email"
            {...EMAIL_INPUT_PROPS}
            maxLength={EMAIL_MAX}
            value={next}
            disabled={busy}
            onChange={(event) => {
              setNext(event.target.value);
              setOutcome(null);
            }}
            {...invalidProps(
              outcome !== null && !outcome.ok ? outcome.message : undefined,
              resultId,
            )}
          />
        </label>
        <Result outcome={outcome} id={resultId} />
        <div>
          <button type="submit" className="p-btn p-btn-dark" disabled={busy || next.trim() === ''}>
            {busy ? 'Sending…' : 'Change email'}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ── Password ───────────────────────────────────────────────────────────────

export function PasswordSection({
  email,
  change,
  framed = true,
}: {
  email: string;
  change: (input: { email: string; current: string; next: string }) => Promise<Outcome>;
  framed?: boolean;
}) {
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Which field the shown problem belongs to, so only it is marked invalid. */
  const [badField, setBadField] = useState<PasswordField | null>(null);
  /** A save was refused: the rules still unmet show as missing, not "to do". */
  const [tried, setTried] = useState(false);
  const resultId = `${uid}-result`;
  const currentId = `${uid}-current`;

  const typed = (setter: (value: string) => void) => (value: string) => {
    setter(value);
    setOutcome(null);
    setBadField(null);
  };
  const marked = (key: PasswordField) =>
    invalidProps(badField === key && outcome !== null ? outcome.message : undefined, resultId);

  const submit = async (): Promise<void> => {
    const issue = passwordIssue(current, next, confirm);
    if (issue !== null) {
      setOutcome({ ok: false, message: issue.message });
      setBadField(issue.field);
      setTried(true);
      return;
    }
    setBusy(true);
    setOutcome(null);
    setBadField(null);
    const result = await change({ email, current, next });
    setBusy(false);
    setOutcome(result);
    if (result.message === ACCOUNT_COPY.wrongPassword) setBadField('current');
    if (result.ok) {
      setCurrent('');
      setNext('');
      setConfirm('');
      setTried(false);
    }
  };

  return (
    <Section title="Password" framed={framed}>
      <form
        style={form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {/* Lets a password manager pair the new password with this account. */}
        <input type="text" name="username" autoComplete="username" value={email} readOnly hidden />
        {/* A <label for>, not a wrapping <label>: the eye button inside the
            field would otherwise become part of the field's name. */}
        <div style={field}>
          <label htmlFor={currentId} className="a-person-sub">
            CURRENT PASSWORD
          </label>
          <PasswordInput
            id={currentId}
            skin="portal"
            name="currentPassword"
            autoComplete="current-password"
            value={current}
            disabled={busy}
            onChange={(event) => typed(setCurrent)(event.target.value)}
            {...marked('current')}
          />
        </div>
        <NewPasswordFields
          skin="portal"
          password={next}
          confirm={confirm}
          onPasswordChange={typed(setNext)}
          onConfirmChange={typed(setConfirm)}
          labels={{ password: 'NEW PASSWORD', confirm: 'CONFIRM NEW PASSWORD' }}
          showMissing={tried}
          disabled={busy}
          invalid={badField === 'next' ? 'password' : badField === 'confirm' ? 'confirm' : null}
          problemId={outcome !== null && !outcome.ok ? resultId : undefined}
        />
        <Result outcome={outcome} id={resultId} />
        <div>
          <button
            type="submit"
            className="p-btn p-btn-dark"
            disabled={busy || current === '' || next === '' || confirm === ''}
          >
            {busy ? 'Changing…' : 'Change password'}
          </button>
        </div>
      </form>
    </Section>
  );
}

// ── Name and phone (owner, 2026-10-23) ─────────────────────────────────────

export function DetailsSection({
  profile,
  save,
  onSaved,
}: {
  profile: MyProfile;
  save: (patch: MyProfilePatch) => Promise<MyProfile>;
  onSaved: (profile: MyProfile) => void;
}) {
  const uid = useId();
  const [values, setValues] = useState<DetailsForm>(() => detailsForm(profile));
  const [touched, setTouched] = useState<ReadonlySet<DetailsField>>(new Set());
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  const { patch, problems, problem } = detailsPatch(profile, values);
  const original = detailsForm(profile);
  const dirty =
    values.firstName !== original.firstName ||
    values.lastName !== original.lastName ||
    values.phone !== original.phone;
  const shown = (key: DetailsField): string | undefined =>
    submitted || touched.has(key) ? problems[key] : undefined;
  const errorId = (key: DetailsField): string => `${uid}-${key}-error`;

  // Letters cannot be typed into the phone, nor digits into a name.
  const set = (key: DetailsField) => (event: { target: { value: string } }) => {
    const raw = event.target.value;
    setValues({
      ...values,
      [key]: key === 'phone' ? filterPhoneTyping(raw) : filterNameTyping(raw),
    });
    setOutcome(null);
  };
  const leave = (key: DetailsField) => () => setTouched(new Set(touched).add(key));

  const submit = async (): Promise<void> => {
    setSubmitted(true);
    if (problem !== null || Object.keys(patch).length === 0) return;
    setBusy(true);
    setOutcome(null);
    try {
      const saved = await save(patch);
      onSaved(saved);
      setValues(detailsForm(saved));
      setTouched(new Set());
      setSubmitted(false);
      setOutcome({ ok: true, message: 'Saved.' });
    } catch (caught) {
      setOutcome({ ok: false, message: describeSaveFailure(caught) });
    } finally {
      setBusy(false);
    }
  };

  const input = (key: DetailsField, label: string, extra: Record<string, unknown>) => (
    <label style={key === 'phone' ? field : half}>
      <Label>{label}</Label>
      <input
        className="a-input"
        name={key}
        type="text"
        value={values[key]}
        disabled={busy}
        onChange={set(key)}
        onBlur={leave(key)}
        {...extra}
        {...invalidProps(shown(key), errorId(key))}
      />
      <FieldError id={errorId(key)} message={shown(key)} />
    </label>
  );

  return (
    <form
      style={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div style={pair}>
        {input('firstName', 'FIRST NAME', {
          autoComplete: 'given-name',
          maxLength: PROFILE_LIMITS.nameMax,
        })}
        {input('lastName', 'LAST NAME', {
          autoComplete: 'family-name',
          maxLength: PROFILE_LIMITS.nameMax,
        })}
      </div>
      {input('phone', 'PHONE — OPTIONAL', {
        type: 'tel',
        inputMode: 'tel',
        autoComplete: 'tel',
        maxLength: PH_PHONE_MAX_INPUT,
        placeholder: '0917 555 0142',
      })}
      <p className="p-muted" style={{ margin: 0, fontSize: 12.5 }}>
        The front desk uses your phone to reach you about your membership and classes.
      </p>
      <Result outcome={outcome} />
      <div>
        <button type="submit" className="p-btn p-btn-dark" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save details'}
        </button>
      </div>
    </form>
  );
}

// ── Delete account (owner, 2026-10-23) ─────────────────────────────────────

const list: CSSProperties = { margin: '4px 0 0', paddingLeft: 18, display: 'grid', gap: 4 };

/**
 * What is erased and what is kept, the active-plan warning, and the password.
 * The decision and the wire are `deleteAccount` in lib/account.ts; this only
 * holds the password and shows the answer.
 */
export function DeleteSection({
  profile,
  remove,
  onDeleted,
  onCancel,
}: {
  profile: MyProfile;
  remove: (password: string) => Promise<Outcome>;
  onDeleted: () => void;
  onCancel: () => void;
}) {
  const uid = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const resultId = `${uid}-result`;
  const passwordId = `${uid}-password`;
  const warning = deletePlanWarning(profile);

  const submit = async (): Promise<void> => {
    if (password === '') {
      setOutcome({ ok: false, message: 'Enter your current password.' });
      return;
    }
    setBusy(true);
    setOutcome(null);
    const result = await remove(password);
    if (result.ok) {
      onDeleted();
      return;
    }
    setBusy(false);
    setOutcome(result);
  };

  return (
    <form
      style={form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div>
        <strong style={{ fontSize: 14 }}>Erased now</strong>
        <ul style={list}>
          <li>Your name, email, phone, photo, birthday and member code</li>
          <li>Your emergency contact and medical notes</li>
          <li>Your body measurements, goals and workout plans</li>
          <li>Your chats with the gym&apos;s AI assistant</li>
          <li>Your upcoming class bookings — the seats go to the waitlist</li>
        </ul>
      </div>
      <div>
        <strong style={{ fontSize: 14 }}>Kept, without your name</strong>
        <ul style={list}>
          <li>
            Payments and memberships (receipt images may still show your GCash name and number)
          </li>
          <li>Visits and class history</li>
          <li>Your chats with your coach and their notes</li>
          <li>Consent records</li>
        </ul>
      </div>
      {warning === null ? null : (
        <p
          role="note"
          style={{
            margin: 0,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'var(--p-danger-bg)',
            color: 'var(--p-danger)',
            fontSize: 13.5,
            fontWeight: 600,
          }}
        >
          {warning}
        </p>
      )}
      {/* Lets a password manager fill the right account's password. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={profile.email}
        readOnly
        hidden
      />
      <div style={field}>
        <label htmlFor={passwordId} className="a-person-sub">
          CURRENT PASSWORD
        </label>
        <PasswordInput
          id={passwordId}
          skin="portal"
          name="deletePassword"
          autoComplete="current-password"
          value={password}
          disabled={busy}
          onChange={(event) => {
            setPassword(event.target.value);
            setOutcome(null);
          }}
          {...invalidProps(
            outcome !== null && !outcome.ok ? outcome.message : undefined,
            resultId,
          )}
        />
      </div>
      <p className="p-muted" style={{ margin: 0, fontSize: 12.5 }}>
        This cannot be undone. You will be signed out straight away.
      </p>
      <Result outcome={outcome} id={resultId} />
      <div style={pair}>
        <button
          type="button"
          className="p-btn p-btn-ghost"
          style={{ flex: '1 1 130px', minHeight: 44 }}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="p-btn acct-danger-btn"
          style={{ flex: '1 1 130px', minHeight: 44 }}
          disabled={busy}
        >
          {busy ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </form>
  );
}
