import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// account.ts imports the API client, which needs Supabase's env at import.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import {
  BodySection,
  DeleteSection,
  DetailsSection,
  EmailSection,
  PasswordSection,
} from './AccountSections';

const PROFILE = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: null,
  memberCode: null,
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
  membership: null,
  canDeleteAccount: true,
};

const noop = vi.fn();

describe('BodySection', () => {
  const html = renderToStaticMarkup(<BodySection profile={PROFILE} save={noop} onSaved={noop} />);

  it('shows the current height, weight and notes', () => {
    expect(html).toContain('value="175"');
    expect(html).toContain('value="72.4"');
    expect(html).toContain('>Bad left knee</textarea>');
  });

  it('has its own Save, disabled while nothing has changed', () => {
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save body &amp; health<\/button>/);
  });

  it('says the planner reads it and the desk never shows it', () => {
    expect(html).toContain('workout planner');
    expect(html).toContain('never shown at the front desk');
  });

  it('offers the medical-notes opt-in, unticked by default, with its helper', () => {
    expect(html).toContain('Let the workout planner use my medical notes');
    expect(html).toContain(
      'Your notes go to the AI that writes your plans so it avoids exercises that could hurt you. Off: they stay on your account and the AI never sees them.',
    );
    const box = /<input[^>]*name="shareMedicalWithPlanner"[^>]*>/.exec(html)?.[0] ?? '';
    expect(box).toContain('type="checkbox"');
    expect(box).not.toContain('checked');
  });

  it('caps the notes at 2000 characters', () => {
    expect(html).toContain('maxLength="2000"');
  });
});

describe('EmailSection', () => {
  const html = renderToStaticMarkup(<EmailSection email={PROFILE.email} change={noop} />);

  it('shows the current email', () => {
    expect(html).toContain('juan@example.com');
  });

  it('has an email field for the new address', () => {
    expect(html).toContain('type="email"');
    expect(html).toContain('autoComplete="email"');
  });
});

describe('PasswordSection', () => {
  const html = renderToStaticMarkup(<PasswordSection email={PROFILE.email} change={noop} />);

  it('asks for the current password and the new one twice', () => {
    expect(html.match(/type="password"/g)).toHaveLength(3);
    expect(html).toContain('autoComplete="current-password"');
    expect(html.match(/autoComplete="new-password"/g)).toHaveLength(2);
  });

  it('gives every one of the three fields its own eye', () => {
    expect(html.match(/aria-label="Show password"/g)).toHaveLength(3);
  });

  it('shows the five rules under the new password, in the light portal skin', () => {
    expect(html).toContain('class="pw-fields pw-portal"');
    expect(html.match(/<li data-state="todo"/g)).toHaveLength(5);
    expect(html).toContain('A special character, like ! @ # $ %');
    expect(html).not.toContain('class="input"');
  });
});

describe('framed={false} — inside a sheet', () => {
  it('renders the form without its own card heading', () => {
    const html = renderToStaticMarkup(
      <EmailSection framed={false} email={PROFILE.email} change={noop} />,
    );
    expect(html.startsWith('<form')).toBe(true);
  });
});

describe('DetailsSection', () => {
  const html = renderToStaticMarkup(<DetailsSection profile={PROFILE} save={noop} onSaved={noop} />);

  it('shows the name, an empty phone, and the right autofill hints', () => {
    expect(html).toContain('value="Juan"');
    expect(html).toContain('value="Dela Cruz"');
    expect(html).toContain('autoComplete="given-name"');
    expect(html).toContain('autoComplete="family-name"');
    expect(html).toContain('type="tel"');
  });

  it('caps a name at 60 characters and starts with Save disabled', () => {
    expect(html.match(/maxLength="60"/g)).toHaveLength(2);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Save details<\/button>/);
  });
});

describe('DeleteSection', () => {
  const html = renderToStaticMarkup(
    <DeleteSection profile={PROFILE} remove={noop} onDeleted={noop} onCancel={noop} />,
  );

  it('asks for the current password', () => {
    expect(html).toContain('autoComplete="current-password"');
    expect(html).toContain('name="deletePassword"');
  });

  it('lets the member see the password they typed', () => {
    expect(html.match(/aria-label="Show password"/g)).toHaveLength(1);
  });

  it('says what is erased and what is kept', () => {
    expect(html).toContain('Erased now');
    expect(html).toContain('Consent records');
    expect(html).toContain('Your chats with your coach and their notes');
  });
});
