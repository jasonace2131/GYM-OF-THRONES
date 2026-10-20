'use client';

import { useId, useState, type CSSProperties, type ReactNode } from 'react';
import { PROFILE_LIMITS, type MyProfile, type MyProfilePatch } from '@got/shared';
import {
  ACCOUNT_COPY,
  PASSWORD_MIN,
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
} from '@/lib/account';
import { EMAIL_INPUT_PROPS } from '@/lib/credentials';
import { Card, CardHead } from '@/components/portal/ui';

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

function Section({ title, children }: { title: string; children: ReactNode }) {
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
}: {
  profile: MyProfile;
  save: (patch: MyProfilePatch) => Promise<MyProfile>;
  onSaved: (profile: MyProfile) => void;
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
    setValues({ ...values, [key]: event.target.value });
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
    <Section title="Body & health">
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
            {...invalidProps(shown('notes'), errorId('notes'))}
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
}: {
  email: string;
  change: (next: string) => Promise<Outcome>;
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
    <Section title="Email">
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
}: {
  email: string;
  change: (input: { email: string; current: string; next: string }) => Promise<Outcome>;
}) {
  const uid = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  /** Which field the shown problem belongs to, so only it is marked invalid. */
  const [badField, setBadField] = useState<PasswordField | null>(null);
  const resultId = `${uid}-result`;

  const typed = (setter: (value: string) => void) => (event: { target: { value: string } }) => {
    setter(event.target.value);
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
    }
  };

  return (
    <Section title="Password">
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
        <label style={field}>
          <Label>CURRENT PASSWORD</Label>
          <input
            className="a-input"
            name="currentPassword"
            type="password"
            autoComplete="current-password"
            value={current}
            disabled={busy}
            onChange={typed(setCurrent)}
            {...marked('current')}
          />
        </label>
        <div style={pair}>
          <label style={half}>
            <Label>NEW PASSWORD</Label>
            <input
              className="a-input"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              value={next}
              disabled={busy}
              onChange={typed(setNext)}
              {...marked('next')}
            />
          </label>
          <label style={half}>
            <Label>CONFIRM NEW PASSWORD</Label>
            <input
              className="a-input"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              minLength={PASSWORD_MIN}
              value={confirm}
              disabled={busy}
              onChange={typed(setConfirm)}
              {...marked('confirm')}
            />
          </label>
        </div>
        <p className="p-muted" style={{ margin: 0, fontSize: 12.5 }}>
          At least {PASSWORD_MIN} characters.
        </p>
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
