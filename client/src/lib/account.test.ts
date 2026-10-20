import { describe, expect, it, vi } from 'vitest';

// account.ts imports ApiError from the API client, which needs Supabase's env
// at import. Nothing here talks to the network.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));

import { ApiError, apiFetch } from '@/lib/api';
import {
  getProfile,
  saveProfile,
  ACCOUNT_COPY,
  bodyForm,
  bodyPatch,
  bodySavedMessage,
  passwordIssue,
  changeEmail,
  changePassword,
  describeSaveFailure,
  emailProblem,
  passwordProblem,
} from './account';

const PROFILE = {
  email: 'juan@example.com',
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
};

describe('bodyForm', () => {
  it('shows the current values as the strings a person edits, and the opt-in', () => {
    expect(bodyForm(PROFILE)).toEqual({
      height: '175',
      weight: '72.4',
      notes: 'Bad left knee',
      share: false,
    });
  });

  it('shows empty fields for values never set', () => {
    expect(bodyForm({ ...PROFILE, heightCm: null, weightKg: null, medicalNotes: null })).toEqual({
      height: '',
      weight: '',
      notes: '',
      share: false,
    });
  });
});

describe('bodyPatch', () => {
  const form = bodyForm(PROFILE);

  it('sends nothing when nothing changed', () => {
    expect(bodyPatch(PROFILE, form)).toEqual({ patch: {}, problems: {}, problem: null });
  });

  it('sends only the field that changed', () => {
    expect(bodyPatch(PROFILE, { ...form, weight: '70.5' })).toEqual({
      patch: { weightKg: 70.5 },
      problems: {},
      problem: null,
    });
  });

  it('treats a retyped equal number as unchanged', () => {
    expect(bodyPatch(PROFILE, { ...form, weight: '72.40', height: ' 175 ' }).patch).toEqual({});
  });

  it('clears a value with null when its field is emptied', () => {
    expect(bodyPatch(PROFILE, { ...form, height: '', weight: '', notes: '  ' }).patch).toEqual({
      heightCm: null,
      weightKg: null,
      medicalNotes: null,
    });
  });

  it('trims the notes it sends', () => {
    expect(bodyPatch(PROFILE, { ...form, notes: '  No overhead pressing  ' }).patch).toEqual({
      medicalNotes: 'No overhead pressing',
    });
  });

  it('sends the opt-in when it changed', () => {
    expect(bodyPatch(PROFILE, { ...form, share: true }).patch).toEqual({
      shareMedicalWithPlanner: true,
    });
  });

  it('accepts a decimal comma', () => {
    expect(bodyPatch(PROFILE, { ...form, weight: '70,5' }).patch).toEqual({ weightKg: 70.5 });
  });

  // The same bounds sign-up accepts, so a stored value always saves back.
  it('refuses a height outside 50–260 cm, on that field', () => {
    const low = bodyPatch(PROFILE, { ...form, height: '49' });
    expect(low.problem).toBe('Height must be between 50 and 260 cm.');
    expect(low.problems).toEqual({ height: 'Height must be between 50 and 260 cm.' });
    expect(bodyPatch(PROFILE, { ...form, height: '261' }).problem).toBe(
      'Height must be between 50 and 260 cm.',
    );
  });

  it('refuses a weight outside 20–400 kg, on that field', () => {
    expect(bodyPatch(PROFILE, { ...form, weight: '19' }).problems).toEqual({
      weight: 'Weight must be between 20 and 400 kg.',
    });
  });

  it('refuses text and more than one decimal', () => {
    expect(bodyPatch(PROFILE, { ...form, weight: 'heavy' }).problem).toBe(
      'Weight must be a number, like 72.5.',
    );
    expect(bodyPatch(PROFILE, { ...form, height: '175.55' }).problem).toBe(
      'Height can have one decimal at most, like 175.5.',
    );
  });

  it('refuses notes over 2000 characters', () => {
    expect(bodyPatch(PROFILE, { ...form, notes: 'a'.repeat(2001) }).problems).toEqual({
      notes: 'Medical notes can be at most 2000 characters.',
    });
  });

  // A value stored by sign-up or by staff with two decimals must never block
  // saving the OTHER fields: only what changed is checked.
  it('does not re-check a field the member left alone', () => {
    const odd = { ...PROFILE, weightKg: 72.45 };
    const result = bodyPatch(odd, { ...bodyForm(odd), notes: 'No running' });
    expect(result).toEqual({ patch: { medicalNotes: 'No running' }, problems: {}, problem: null });
  });
});

describe('bodySavedMessage', () => {
  it('says the planner uses the numbers, and the notes only when shared', () => {
    expect(bodySavedMessage(PROFILE)).toBe(
      'Saved. Your coach and your next workout plan use your height and weight.',
    );
    expect(bodySavedMessage({ ...PROFILE, shareMedicalWithPlanner: true })).toBe(
      'Saved. Your coach and your next workout plan use your height and weight, and the planner reads your medical notes.',
    );
  });
});

describe('passwordIssue', () => {
  it('names the field each problem belongs to', () => {
    expect(passwordIssue('', 'longenough', 'longenough')?.field).toBe('current');
    expect(passwordIssue('old-password', 'short', 'short')?.field).toBe('next');
    expect(passwordIssue('old-password', 'longenough', 'longenougH')?.field).toBe('confirm');
    expect(passwordIssue('old-password', 'new-password', 'new-password')).toBeNull();
  });
});

describe('passwordProblem', () => {
  it('needs the current password', () => {
    expect(passwordProblem('', 'longenough', 'longenough')).toBe('Enter your current password.');
  });

  it('needs at least 8 characters, like every other password screen', () => {
    expect(passwordProblem('old-password', 'short', 'short')).toBe('Use at least 8 characters.');
  });

  it('needs the two new passwords to match', () => {
    expect(passwordProblem('old-password', 'longenough', 'longenougH')).toBe(
      'The two passwords do not match.',
    );
  });

  it('needs the new password to differ from the current one', () => {
    expect(passwordProblem('same-password', 'same-password', 'same-password')).toBe(
      'Choose a password different from your current one.',
    );
  });

  it('passes a good change', () => {
    expect(passwordProblem('old-password', 'new-password', 'new-password')).toBeNull();
  });
});

describe('emailProblem', () => {
  it('refuses something that is not an email', () => {
    expect(emailProblem('juan@example.com', 'juan')).toBe('Enter a valid email address.');
  });

  it('refuses the current address, whatever its case or spacing', () => {
    expect(emailProblem('juan@example.com', ' Juan@Example.com ')).toBe(
      'That is already your email.',
    );
  });

  it('passes a new address', () => {
    expect(emailProblem('juan@example.com', 'juan.new@example.com')).toBeNull();
  });
});

describe('describeSaveFailure', () => {
  it("shows the server's own 4xx message", () => {
    expect(
      describeSaveFailure(new ApiError('weightKg must not be greater than 350', 400, 'X')),
    ).toBe('weightKg must not be greater than 350');
  });

  it('falls back for a 5xx or anything else', () => {
    expect(describeSaveFailure(new ApiError('Internal server error', 500, 'X'))).toBe(
      "Couldn't save. Try again.",
    );
    expect(describeSaveFailure(new Error('offline'))).toBe("Couldn't save. Try again.");
  });
});

describe('changePassword', () => {
  const input = { email: 'juan@example.com', current: 'old-password', next: 'new-password' };

  it('checks the current password, then sets the new one', async () => {
    const verify = vi.fn().mockResolvedValue('ok');
    const update = vi.fn().mockResolvedValue({ error: null });
    await expect(changePassword({ verify, update }, input)).resolves.toEqual({
      ok: true,
      message: 'Password changed.',
    });
    expect(verify).toHaveBeenCalledWith('juan@example.com', 'old-password');
    expect(update).toHaveBeenCalledWith('new-password');
  });

  it('stops with the exact copy when the current password is wrong', async () => {
    const verify = vi.fn().mockResolvedValue('wrong');
    const update = vi.fn();
    await expect(changePassword({ verify, update }, input)).resolves.toEqual({
      ok: false,
      message: "That's not your current password.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back when the check itself could not run', async () => {
    const verify = vi.fn().mockResolvedValue('error');
    const update = vi.fn();
    await expect(changePassword({ verify, update }, input)).resolves.toEqual({
      ok: false,
      message: "Couldn't save. Try again.",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("shows Supabase's reason when the update is refused", async () => {
    const verify = vi.fn().mockResolvedValue('ok');
    const update = vi.fn().mockResolvedValue({ error: { message: 'Password is too weak' } });
    await expect(changePassword({ verify, update }, input)).resolves.toEqual({
      ok: false,
      message: 'Password is too weak',
    });
  });

  it('falls back when the update throws', async () => {
    const verify = vi.fn().mockResolvedValue('ok');
    const update = vi.fn().mockRejectedValue(new Error('network'));
    await expect(changePassword({ verify, update }, input)).resolves.toEqual({
      ok: false,
      message: "Couldn't save. Try again.",
    });
  });
});

describe('changeEmail', () => {
  it('asks Supabase for the normalised address and says to check both inboxes', async () => {
    const update = vi.fn().mockResolvedValue({ error: null });
    await expect(changeEmail({ update }, '  Juan.New@Example.com ')).resolves.toEqual({
      ok: true,
      message: ACCOUNT_COPY.emailSent,
    });
    expect(update).toHaveBeenCalledWith('juan.new@example.com');
    expect(ACCOUNT_COPY.emailSent).toBe(
      'Check both inboxes — we sent a confirmation link. Your email changes once you open it.',
    );
  });

  it("shows Supabase's reason when it refuses", async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ error: { message: 'Email address already registered' } });
    await expect(changeEmail({ update }, 'taken@example.com')).resolves.toEqual({
      ok: false,
      message: 'Email address already registered',
    });
  });

  it('falls back when the call throws', async () => {
    const update = vi.fn().mockRejectedValue(new Error('network'));
    await expect(changeEmail({ update }, 'new@example.com')).resolves.toEqual({
      ok: false,
      message: "Couldn't save. Try again.",
    });
  });
});

describe('the /me/profile calls', () => {
  it('reads the profile', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce(PROFILE);
    await expect(getProfile()).resolves.toEqual(PROFILE);
    expect(apiFetch).toHaveBeenCalledWith('/me/profile');
  });

  it('PATCHes exactly the changed fields, and nothing else', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ...PROFILE, weightKg: 70.5 });
    const { patch } = bodyPatch(PROFILE, { ...bodyForm(PROFILE), weight: '70.5' });
    await saveProfile(patch);
    expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ weightKg: 70.5 }),
    });
  });
});
