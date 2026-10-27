import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The account page driven end to end in jsdom: load, open a sheet, type,
 * leave the field, press Save — with the network mocked at `apiFetch` and
 * Supabase mocked at `accountAuth`, so what is asserted is exactly what would
 * go on the wire. Sheets portal into `document.body`, so queries look there.
 */

const { apiFetch, verifyCurrentPassword, updatePassword, updateEmail, signOutMember, replace, reload } =
  vi.hoisted(() => ({
    apiFetch: vi.fn(),
    verifyCurrentPassword: vi.fn(),
    updatePassword: vi.fn(),
    updateEmail: vi.fn(),
    signOutMember: vi.fn(),
    replace: vi.fn(),
    reload: vi.fn(),
  }));

vi.mock('@/lib/api', () => ({
  apiFetch,
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
vi.mock('@/lib/accountAuth', () => ({ verifyCurrentPassword, updatePassword, updateEmail }));
vi.mock('@/lib/memberSignOut', () => ({ signOutMember }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace }) }));
vi.mock('@/components/rbac/MeProvider', () => ({ useMe: () => ({ reload }) }));

import AccountPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: '+63 917 555 0142' as string | null,
  memberCode: 'K7Q2MX' as string | null,
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee' as string | null,
  shareMedicalWithPlanner: false,
  membership: { planName: 'Quarterly', status: 'ACTIVE', endsOn: '2027-01-11', daysLeft: 80 } as {
    planName: string;
    status: string;
    endsOn: string;
    daysLeft: number;
  } | null,
  canDeleteAccount: true,
};

let container: HTMLDivElement;
let root: Root;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function renderPage(profile: typeof PROFILE = PROFILE): Promise<void> {
  apiFetch.mockResolvedValueOnce(profile);
  await act(async () => {
    root.render(<AccountPage />);
  });
  await flush();
}

const page = (): string => document.body.textContent ?? '';

const byName = <T extends HTMLElement>(name: string): T => {
  const el = document.body.querySelector<T>(`[name="${name}"]`);
  if (el === null) throw new Error(`no field ${name}`);
  return el;
};

const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

/** A list row's button, by the bold label inside it. */
const row = (label: string): HTMLElement => {
  const found = [...document.body.querySelectorAll<HTMLElement>('.acct-li')].find(
    (el) => el.querySelector('b')?.textContent === label,
  );
  if (found === undefined) throw new Error(`no row ${label}`);
  return found;
};

/** Type into a controlled input the way React sees it. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

describe('My account page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }) as unknown as typeof window.matchMedia;
    window.sessionStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  });

  async function renderFailing(error: unknown): Promise<void> {
    apiFetch.mockRejectedValueOnce(error);
    await act(async () => {
      root.render(<AccountPage />);
    });
    await flush();
  }

  it('blames the connection only when the request never got an answer', async () => {
    await renderFailing(new TypeError('Failed to fetch'));
    expect(page()).toContain("Couldn't load your account.");
    expect(page()).toContain('Check your connection and try again.');
    expect(button('Try again')).toBeTruthy();
  });

  it('says "try again in a moment" for an HTTP error, not "check your connection"', async () => {
    const { ApiError } = await import('@/lib/api');
    await renderFailing(new ApiError('Not found', 404, 'NOT_FOUND'));
    expect(page()).toContain('Try again in a moment.');
    expect(page()).not.toContain('Check your connection');
  });

  describe('the summary', () => {
    it('greets the member in the profile band', async () => {
      await renderPage();
      expect(apiFetch).toHaveBeenCalledWith('/me/profile');
      const band = container.querySelector('section[aria-label="Your profile"]');
      expect(band?.querySelector('h1')?.textContent).toBe('Juan Dela Cruz');
      expect(band?.textContent).toContain('Welcome back');
      expect(band?.querySelector('.acct-avatar')?.textContent).toBe('JD');
      expect(container.querySelector('.acct-badge')?.textContent).toBe('Quarterly · ACTIVE');
      const facts = [...(band?.querySelectorAll('.acct-fact') ?? [])].map((fact) => [
        fact.querySelector('dt')?.textContent,
        fact.querySelector('dd')?.textContent,
      ]);
      expect(facts).toEqual([
        ['Email', 'juan@example.com'],
        ['Phone', '+63 917 555 0142'],
        ['Member code', 'K7Q2MX'],
      ]);
    });

    it('falls back to the email for the initials when there is no name', async () => {
      await renderPage({ ...PROFILE, firstName: '', lastName: '' });
      expect(container.querySelector('h1')?.textContent).toBe('juan@example.com');
      expect(container.querySelector('.acct-avatar')?.textContent).toBe('J');
    });

    it('says NO PLAN, and what is missing, when there is nothing on file', async () => {
      await renderPage({ ...PROFILE, membership: null, phone: null, memberCode: null });
      expect(container.querySelector('.acct-badge')?.textContent).toBe('No plan');
      expect(page()).toContain('Not added');
      expect(page()).toContain('Not issued yet');
      const tile = container.querySelector('a[href="/portal/subscription"]');
      expect(tile?.textContent).toContain('No plan yet');
      expect(tile?.textContent).toContain('A plan opens class booking, Workouts and My Coach.');
      expect(tile?.querySelector('.acct-go')?.textContent).toBe('See plans');
    });

    it('keeps an ended plan in words', async () => {
      await renderPage({
        ...PROFILE,
        membership: { planName: 'Quarterly', status: 'EXPIRED', endsOn: '2026-10-01', daysLeft: 0 },
      });
      const tile = container.querySelector('a[href="/portal/subscription"]');
      expect(tile?.textContent).toContain('Quarterly · expired · ended 1 Oct');
    });

    it('puts password, email, sign out and delete together under Sign-in & security', async () => {
      await renderPage();
      const card = container.querySelector('section[aria-labelledby="acct-sec-h"]');
      expect(card?.querySelector('h2')?.textContent).toBe('Sign-in & security');
      const labels = [...(card?.querySelectorAll('.acct-li b') ?? [])].map((b) => b.textContent);
      expect(labels).toEqual(['Change password', 'Change email', 'Sign out', 'Delete account']);
    });

    it('shows height, weight, BMI and the notes — no chip at a healthy BMI', async () => {
      await renderPage();
      const stats = [...container.querySelectorAll('.acct-stat dd')].map((dd) => dd.textContent);
      expect(stats).toEqual(['175', '72.4', '23.6']);
      expect(page()).toContain('Bad left knee');
      expect(container.querySelector('.acct-chip')).toBeNull();
    });

    it('shows the under-18.5 note and "No notes"', async () => {
      await renderPage({ ...PROFILE, heightCm: 185, weightKg: 62, medicalNotes: null });
      expect(container.querySelector('.acct-chip')?.textContent).toBe(
        'BMI under 18.5, so “Lose fat” is hidden in the workout planner.',
      );
      expect(page()).toContain('No notes');
    });

    it('links the three tiles, with the days left as the headline', async () => {
      await renderPage();
      const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toEqual(['/portal/subscription', '/portal/pay', '/terms']);
      const tile = container.querySelector('a[href="/portal/subscription"]');
      expect(tile?.querySelector('.acct-tile-big')?.textContent).toBe('80');
      expect(tile?.textContent).toContain('days left on Quarterly');
      expect(tile?.textContent).toContain('Active until 11 Jan.');
      const actions = [...container.querySelectorAll('.acct-go')].map((go) => go.textContent);
      expect(actions).toEqual(['Manage', 'View', 'Read']);
    });

    it('says 1 day, not 1 days', async () => {
      await renderPage({
        ...PROFILE,
        membership: { planName: 'Monthly', status: 'ACTIVE', endsOn: '2026-10-28', daysLeft: 1 },
      });
      expect(page()).toContain('day left on Monthly');
      expect(page()).not.toContain('days left on Monthly');
    });

    it('the planner switch saves at once', async () => {
      await renderPage();
      const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]');
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      apiFetch.mockResolvedValueOnce({ ...PROFILE, shareMedicalWithPlanner: true });

      await click(toggle!);

      expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ shareMedicalWithPlanner: true }),
      });
      expect(toggle?.getAttribute('aria-checked')).toBe('true');
    });

    it('signs out through the shared sign-out', async () => {
      await renderPage();
      await click(row('Sign out'));
      // Asks first: nothing has happened yet.
      expect(signOutMember).not.toHaveBeenCalled();
      const dialog = document.querySelector('[role="alertdialog"]');
      expect(dialog?.textContent).toContain('Sign out?');
      const confirm = [...dialog!.querySelectorAll('button')].find(
        (b) => b.textContent === 'Sign out',
      )!;
      await click(confirm);
      expect(signOutMember).toHaveBeenCalledWith();
      expect(replace).toHaveBeenCalledWith('/login');
    });
  });

  describe('Body & health sheet', () => {
    async function open(): Promise<void> {
      await renderPage();
      await click(button('Edit body & health'));
    }

    it('opens on the current values', async () => {
      await open();
      expect(byName<HTMLInputElement>('heightCm').value).toBe('175');
      expect(byName<HTMLInputElement>('weightKg').value).toBe('72.4');
      expect(byName<HTMLTextAreaElement>('medicalNotes').value).toBe('Bad left knee');
      expect(byName<HTMLInputElement>('shareMedicalWithPlanner').checked).toBe(false);
    });

    it('saves only the changed field and says what happens next', async () => {
      await open();
      await type(byName('weightKg'), '70.5');
      apiFetch.mockResolvedValueOnce({ ...PROFILE, weightKg: 70.5 });

      await click(button('Save body & health'));

      expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ weightKg: 70.5 }),
      });
      expect(document.body.querySelector('[role="status"]')?.textContent).toBe(
        'Saved. Your coach and your next workout plan use your height and weight.',
      );
    });

    it('shows a field problem only after the field is left, and marks the field', async () => {
      await open();
      const weight = byName<HTMLInputElement>('weightKg');
      await type(weight, '19');
      expect(weight.getAttribute('aria-invalid')).toBeNull();

      await blur(weight);

      const alert = document.getElementById(weight.getAttribute('aria-describedby') ?? '');
      expect(alert?.textContent).toBe('Weight must be between 20 and 400 kg.');
      expect(weight.getAttribute('aria-invalid')).toBe('true');
    });

    it('does not send an invalid save', async () => {
      await open();
      await type(byName('heightCm'), '300');
      apiFetch.mockClear();
      await click(button('Save body & health'));
      expect(apiFetch).not.toHaveBeenCalled();
      expect(page()).toContain('Height must be between 50 and 260 cm.');
    });
  });

  describe('Edit details sheet', () => {
    async function open(): Promise<void> {
      await renderPage();
      await click(document.body.querySelector<HTMLButtonElement>('.acct-pill')!);
    }

    it('saves a new name and phone, then refreshes /me for the topbar', async () => {
      await open();
      expect(byName<HTMLInputElement>('firstName').value).toBe('Juan');
      await type(byName('firstName'), ' Juanito ');
      await type(byName('phone'), '0917 555 0199');
      apiFetch.mockResolvedValueOnce({ ...PROFILE, firstName: 'Juanito', phone: '+639175550199' });

      await click(button('Save details'));

      expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
        method: 'PATCH',
        body: JSON.stringify({ firstName: 'Juanito', phone: '+639175550199' }),
      });
      expect(reload).toHaveBeenCalled();
      expect(container.querySelector('h1')?.textContent).toBe('Juanito Dela Cruz');
    });

    it('refuses an empty first name on that field', async () => {
      await open();
      const first = byName<HTMLInputElement>('firstName');
      await type(first, '');
      await blur(first);
      expect(first.getAttribute('aria-invalid')).toBe('true');
      expect(page()).toContain('Enter your first name.');
      apiFetch.mockClear();
      await click(button('Save details'));
      expect(apiFetch).not.toHaveBeenCalled();
    });
  });

  describe('password and email sheets', () => {
    it('marks the current password wrong without changing anything', async () => {
      await renderPage();
      await click(row('Change password'));
      verifyCurrentPassword.mockResolvedValue('wrong');
      await type(byName('currentPassword'), 'not-it');
      await type(byName('newPassword'), 'Thr0nes!Gym');
      await type(byName('confirmPassword'), 'Thr0nes!Gym');

      await click(button('Change password'));

      expect(verifyCurrentPassword).toHaveBeenCalledWith('juan@example.com', 'not-it');
      expect(updatePassword).not.toHaveBeenCalled();
      expect(page()).toContain("That's not your current password.");
      expect(byName('currentPassword').getAttribute('aria-invalid')).toBe('true');
    });

    it('refuses a new password that misses a rule before checking the current one', async () => {
      await renderPage();
      await click(row('Change password'));
      await type(byName('currentPassword'), 'old-password');
      await type(byName('newPassword'), 'newpassword');
      await type(byName('confirmPassword'), 'newpassword');

      await click(button('Change password'));

      expect(verifyCurrentPassword).not.toHaveBeenCalled();
      expect(page()).toContain(
        'Your password still needs an uppercase letter, a number and a special character.',
      );
      expect(byName('newPassword').getAttribute('aria-invalid')).toBe('true');
      expect(document.body.querySelectorAll('.pw-rules li[data-state="missing"]')).toHaveLength(3);
    });

    it('changes the password and says so', async () => {
      await renderPage();
      await click(row('Change password'));
      verifyCurrentPassword.mockResolvedValue('ok');
      updatePassword.mockResolvedValue({ error: null });
      await type(byName('currentPassword'), 'old-password');
      await type(byName('newPassword'), 'Thr0nes!Gym');
      await type(byName('confirmPassword'), 'Thr0nes!Gym');

      await click(button('Change password'));

      expect(updatePassword).toHaveBeenCalledWith('Thr0nes!Gym');
      expect(page()).toContain('Password changed.');
    });

    it('opens Change email from the security card too', async () => {
      await renderPage();
      await click(row('Change email'));
      expect(byName<HTMLInputElement>('email')).toBeTruthy();
    });

    it('asks for the email change and says to check both inboxes', async () => {
      await renderPage();
      await click(button('Change email'));
      updateEmail.mockResolvedValue({ error: null });
      await type(byName('email'), 'juan.new@example.com');

      const submit = [...document.body.querySelectorAll('button[type="submit"]')].find(
        (b) => b.textContent === 'Change email',
      ) as HTMLButtonElement;
      await click(submit);

      expect(updateEmail).toHaveBeenCalledWith('juan.new@example.com');
      expect(page()).toContain(
        'Check both inboxes — we sent a confirmation link. Your email changes once you open it.',
      );
    });
  });

  describe('Delete account', () => {
    it('is not offered to an account that may not delete itself', async () => {
      await renderPage({ ...PROFILE, canDeleteAccount: false });
      expect(() => row('Delete account')).toThrow();
    });

    it('lists what is erased and kept, and warns about the days left', async () => {
      await renderPage();
      await click(row('Delete account'));
      expect(page()).toContain('Erased now');
      expect(page()).toContain('Kept, without your name');
      expect(page()).toContain("Your Quarterly plan has 80 days left. They'll be lost.");
      expect(button('Delete my account')).toBeTruthy();
      expect(button('Cancel')).toBeTruthy();
    });

    it('does not warn without an active plan', async () => {
      await renderPage({ ...PROFILE, membership: null });
      await click(row('Delete account'));
      expect(page()).not.toContain("They'll be lost");
    });

    it('stops at a wrong password without calling the API', async () => {
      await renderPage();
      await click(row('Delete account'));
      verifyCurrentPassword.mockResolvedValue('wrong');
      apiFetch.mockClear();
      await type(byName('deletePassword'), 'not-it');

      await click(button('Delete my account'));

      expect(apiFetch).not.toHaveBeenCalled();
      expect(page()).toContain("That's not your current password.");
      expect(byName('deletePassword').getAttribute('aria-invalid')).toBe('true');
    });

    it('deletes, signs out locally and goes home with the notice', async () => {
      await renderPage();
      await click(row('Delete account'));
      verifyCurrentPassword.mockResolvedValue('ok');
      apiFetch.mockResolvedValueOnce({ deleted: true });
      await type(byName('deletePassword'), 'secret12');

      await click(button('Delete my account'));

      expect(apiFetch).toHaveBeenLastCalledWith('/me/delete-account', {
        method: 'POST',
        body: JSON.stringify({ confirm: true, password: 'secret12' }),
      });
      expect(signOutMember).toHaveBeenCalledWith('local');
      expect(window.sessionStorage.getItem('got.accountDeleted')).toBe('1');
      expect(replace).toHaveBeenCalledWith('/');
    });
  });
});
