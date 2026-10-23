import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * The account page driven end to end in jsdom: load, type, leave the field,
 * press Save — with the network mocked at `apiFetch` and Supabase mocked at
 * `accountAuth`, so what is asserted is exactly what would go on the wire.
 */

const { apiFetch, verifyCurrentPassword, updatePassword, updateEmail } = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  verifyCurrentPassword: vi.fn(),
  updatePassword: vi.fn(),
  updateEmail: vi.fn(),
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

import AccountPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROFILE = {
  email: 'juan@example.com',
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
};

let container: HTMLDivElement;
let root: Root;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function renderPage(): Promise<void> {
  apiFetch.mockResolvedValueOnce(PROFILE);
  await act(async () => {
    root.render(<AccountPage />);
  });
  await flush();
}

const byName = <T extends HTMLElement>(name: string): T => {
  const el = container.querySelector<T>(`[name="${name}"]`);
  if (el === null) throw new Error(`no field ${name}`);
  return el;
};

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
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
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
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
    expect(container.textContent).toContain("Couldn't load your account.");
    expect(container.textContent).toContain('Check your connection and try again.');
    expect(button('Try again')).toBeTruthy();
  });

  it('says "try again in a moment" for an HTTP error, not "check your connection"', async () => {
    const { ApiError } = await import('@/lib/api');
    await renderFailing(new ApiError('Not found', 404, 'NOT_FOUND'));
    expect(container.textContent).toContain("Couldn't load your account.");
    expect(container.textContent).toContain('Try again in a moment.');
    expect(container.textContent).not.toContain('Check your connection');
    expect(button('Try again')).toBeTruthy();
  });

  it('loads the profile and shows the current values', async () => {
    await renderPage();
    expect(apiFetch).toHaveBeenCalledWith('/me/profile');
    expect(byName<HTMLInputElement>('heightCm').value).toBe('175');
    expect(byName<HTMLInputElement>('weightKg').value).toBe('72.4');
    expect(byName<HTMLTextAreaElement>('medicalNotes').value).toBe('Bad left knee');
    expect(byName<HTMLInputElement>('shareMedicalWithPlanner').checked).toBe(false);
    expect(container.textContent).toContain('juan@example.com');
  });

  it('saves only the changed field and says what happens next', async () => {
    await renderPage();
    await type(byName('weightKg'), '70.5');
    apiFetch.mockResolvedValueOnce({ ...PROFILE, weightKg: 70.5 });

    await click(button('Save body & health'));

    expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ weightKg: 70.5 }),
    });
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'Saved. Your coach and your next workout plan use your height and weight.',
    );
  });

  it('sends the medical-notes opt-in when ticked', async () => {
    await renderPage();
    await click(byName('shareMedicalWithPlanner'));
    apiFetch.mockResolvedValueOnce({ ...PROFILE, shareMedicalWithPlanner: true });

    await click(button('Save body & health'));

    expect(apiFetch).toHaveBeenLastCalledWith('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ shareMedicalWithPlanner: true }),
    });
    expect(container.textContent).toContain('Let the workout planner use my medical notes');
  });

  it('shows a field problem only after the field is left, and marks the field', async () => {
    await renderPage();
    const weight = byName<HTMLInputElement>('weightKg');
    await type(weight, '19');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(weight.getAttribute('aria-invalid')).toBeNull();

    await blur(weight);

    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('Weight must be between 20 and 400 kg.');
    expect(weight.getAttribute('aria-invalid')).toBe('true');
    expect(weight.getAttribute('aria-describedby')).toBe(alert?.id);
  });

  it('does not send an invalid save, and shows why on Save', async () => {
    await renderPage();
    await type(byName('heightCm'), '300');
    apiFetch.mockClear();

    await click(button('Save body & health'));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Height must be between 50 and 260 cm.',
    );
  });

  it("shows the server's 4xx message, and the generic line otherwise", async () => {
    await renderPage();
    await type(byName('weightKg'), '70');
    const { ApiError } = await import('@/lib/api');
    apiFetch.mockRejectedValueOnce(new ApiError('weightKg must be a number', 400, 'X'));
    await click(button('Save body & health'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'weightKg must be a number',
    );

    apiFetch.mockRejectedValueOnce(new Error('offline'));
    await click(button('Save body & health'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't save. Try again.",
    );
  });

  it('marks the current password wrong without changing anything', async () => {
    await renderPage();
    verifyCurrentPassword.mockResolvedValue('wrong');
    await type(byName('currentPassword'), 'not-it');
    await type(byName('newPassword'), 'new-password');
    await type(byName('confirmPassword'), 'new-password');

    await click(button('Change password'));

    expect(verifyCurrentPassword).toHaveBeenCalledWith('juan@example.com', 'not-it');
    expect(updatePassword).not.toHaveBeenCalled();
    expect(container.textContent).toContain("That's not your current password.");
    expect(byName('currentPassword').getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a short or mismatched new password before calling Supabase', async () => {
    await renderPage();
    await type(byName('currentPassword'), 'old-password');
    await type(byName('newPassword'), 'short');
    await type(byName('confirmPassword'), 'short');
    await click(button('Change password'));
    expect(container.textContent).toContain('Use at least 8 characters.');
    expect(byName('newPassword').getAttribute('aria-invalid')).toBe('true');

    await type(byName('newPassword'), 'long-enough');
    await type(byName('confirmPassword'), 'long-enougH');
    await click(button('Change password'));
    expect(container.textContent).toContain('The two passwords do not match.');
    expect(byName('confirmPassword').getAttribute('aria-invalid')).toBe('true');
    expect(verifyCurrentPassword).not.toHaveBeenCalled();
  });

  it('changes the password and says so', async () => {
    await renderPage();
    verifyCurrentPassword.mockResolvedValue('ok');
    updatePassword.mockResolvedValue({ error: null });
    await type(byName('currentPassword'), 'old-password');
    await type(byName('newPassword'), 'new-password');
    await type(byName('confirmPassword'), 'new-password');

    await click(button('Change password'));

    expect(updatePassword).toHaveBeenCalledWith('new-password');
    expect(container.textContent).toContain('Password changed.');
  });

  it('asks for the email change and says to check both inboxes', async () => {
    await renderPage();
    updateEmail.mockResolvedValue({ error: null });
    await type(byName('email'), 'juan.new@example.com');

    await click(button('Change email'));

    expect(updateEmail).toHaveBeenCalledWith('juan.new@example.com');
    expect(container.textContent).toContain(
      'Check both inboxes — we sent a confirmation link. Your email changes once you open it.',
    );
  });
});
