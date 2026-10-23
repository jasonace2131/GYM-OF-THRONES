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
  detailsForm,
  detailsPatch,
  deletePlanWarning,
  deleteAccount,
  ACCOUNT_DELETED_NOTICE,
} from './account';
import type { MyProfile } from '@got/shared';

const PROFILE = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: '+63 917 555 0142' as string | null,
  memberCode: 'K7Q2MX' as string | null,
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
  membership: {
    planName: 'Quarterly',
    status: 'ACTIVE',
    endsOn: '2027-01-11',
    daysLeft: 80,
  } as MyProfile['membership'],
  canDeleteAccount: true,
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

describe('deletePlanWarning', () => {
  it('warns about the days an ACTIVE plan still has', () => {
    expect(deletePlanWarning(PROFILE)).toBe("Your Quarterly plan has 80 days left. They'll be lost.");
  });

  it('says "1 day" for one', () => {
    expect(
      deletePlanWarning({ ...PROFILE, membership: { ...PROFILE.membership!, daysLeft: 1 } }),
    ).toBe("Your Quarterly plan has 1 day left. It'll be lost.");
  });

  it('says nothing without an active plan', () => {
    expect(deletePlanWarning({ ...PROFILE, membership: null })).toBeNull();
    expect(
      deletePlanWarning({ ...PROFILE, membership: { ...PROFILE.membership!, status: 'EXPIRED' } }),
    ).toBeNull();
  });
});

describe('deleteAccount', () => {
  const input = { email: 'juan@example.com', password: ' secret12 ' };

  it('checks the password, then asks the API to delete, with the password', async () => {
    const verify = vi.fn().mockResolvedValue('ok');
    vi.mocked(apiFetch).mockResolvedValueOnce({ deleted: true });
    await expect(deleteAccount({ verify }, input)).resolves.toEqual({
      ok: true,
      message: ACCOUNT_DELETED_NOTICE,
    });
    expect(verify).toHaveBeenCalledWith('juan@example.com', ' secret12 ');
    expect(apiFetch).toHaveBeenLastCalledWith('/me/delete-account', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, password: ' secret12 ' }),
    });
    expect(ACCOUNT_DELETED_NOTICE).toBe('Your account was deleted.');
  });

  it('stops at a wrong password without calling the API', async () => {
    vi.mocked(apiFetch).mockClear();
    const verify = vi.fn().mockResolvedValue('wrong');
    await expect(deleteAccount({ verify }, input)).resolves.toEqual({
      ok: false,
      message: ACCOUNT_COPY.wrongPassword,
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('falls back when the check could not run', async () => {
    const verify = vi.fn().mockResolvedValue('error');
    await expect(deleteAccount({ verify }, input)).resolves.toEqual({
      ok: false,
      message: ACCOUNT_COPY.saveFailed,
    });
  });

  it("shows the server's 4xx reason, and the generic line otherwise", async () => {
    const verify = vi.fn().mockResolvedValue('ok');
    vi.mocked(apiFetch).mockRejectedValueOnce(
      new ApiError("That's not your current password.", 422, 'WRONG_PASSWORD'),
    );
    await expect(deleteAccount({ verify }, input)).resolves.toEqual({
      ok: false,
      message: "That's not your current password.",
    });
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('network'));
    await expect(deleteAccount({ verify }, input)).resolves.toEqual({
      ok: false,
      message: ACCOUNT_COPY.saveFailed,
    });
  });
});

describe('detailsForm', () => {
  it('shows the name and phone as the strings a person edits', () => {
    expect(detailsForm(PROFILE)).toEqual({
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      phone: '+63 917 555 0142',
    });
    expect(detailsForm({ ...PROFILE, phone: null }).phone).toBe('');
  });
});

describe('detailsPatch', () => {
  const form = detailsForm(PROFILE);

  it('sends nothing when nothing changed', () => {
    expect(detailsPatch(PROFILE, form)).toEqual({ patch: {}, problems: {}, problem: null });
  });

  it('sends only the trimmed fields that changed', () => {
    expect(detailsPatch(PROFILE, { ...form, firstName: '  Juanito ' }).patch).toEqual({
      firstName: 'Juanito',
    });
  });

  it('clears the phone with null when it is emptied', () => {
    expect(detailsPatch(PROFILE, { ...form, phone: '  ' }).patch).toEqual({ phone: null });
  });

  it('sends a PH mobile as +639XXXXXXXXX, like the server', () => {
    expect(detailsPatch(PROFILE, { ...form, phone: ' 0917  555 0199 ' }).patch).toEqual({
      phone: '+639175550199',
    });
  });

  it('collapses the spaces inside a name', () => {
    expect(detailsPatch(PROFILE, { ...form, lastName: ' Dela   Rosa ' }).patch).toEqual({
      lastName: 'Dela Rosa',
    });
  });

  it('needs a first and a last name, on that field', () => {
    const result = detailsPatch(PROFILE, { ...form, firstName: ' ', lastName: '' });
    expect(result.patch).toEqual({});
    expect(result.problems).toEqual({
      firstName: 'Enter your first name.',
      lastName: 'Enter your last name.',
    });
    expect(result.problem).toBe('Enter your first name.');
  });

  it('holds a name to 60 characters', () => {
    expect(detailsPatch(PROFILE, { ...form, lastName: 'a'.repeat(61) }).problems.lastName).toBe(
      'Your last name can be at most 60 characters.',
    );
  });

  it('refuses digits and symbols in a name, but not accents, apostrophes, hyphens or dots', () => {
    expect(detailsPatch(PROFILE, { ...form, firstName: 'Juan2' }).problems.firstName).toBe(
      "Use letters, spaces, apostrophes ('), hyphens (-) and dots only.",
    );
    expect(
      detailsPatch(PROFILE, { ...form, firstName: 'Ma. Niña', lastName: "O'Brien-Santos" })
        .problem,
    ).toBeNull();
  });

  it('refuses anything but a PH mobile, landlines included', () => {
    const message = 'Enter a PH mobile number — 09XX XXX XXXX or +63 9XX XXX XXXX.';
    expect(detailsPatch(PROFILE, { ...form, phone: 'call me' }).problems.phone).toBe(message);
    expect(detailsPatch(PROFILE, { ...form, phone: '(02) 8123 4567' }).problems.phone).toBe(
      message,
    );
  });

  it('does not re-check a field the member left alone', () => {
    // A provisioning-era empty last name must not block saving the phone.
    const legacy = { ...PROFILE, lastName: '' };
    expect(detailsPatch(legacy, { ...detailsForm(legacy), phone: '0917 555 0199' })).toEqual({
      patch: { phone: '+639175550199' },
      problems: {},
      problem: null,
    });
  });
});
