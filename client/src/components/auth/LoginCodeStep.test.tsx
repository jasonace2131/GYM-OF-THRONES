import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// loginCode.ts imports the API client, which needs Supabase's env at import.
// Nothing here talks to the network (same approach as SessionCard.test.tsx).
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { LoginCodeStep, type LoginCodeStepProps } from './LoginCodeStep';

const noop = (): void => undefined;

const render = (over: Partial<LoginCodeStepProps> = {}): string =>
  renderToStaticMarkup(
    <LoginCodeStep
      sentTo="ju***@gmail.com"
      code=""
      error={null}
      verifying={false}
      resending={false}
      resendSecondsLeft={0}
      onCodeChange={noop}
      onVerify={noop}
      onResend={noop}
      onSwitchAccount={noop}
      {...over}
    />,
  );

/** The opening tag of the button whose text is `label`. */
const buttonTag = (html: string, label: string): string => {
  const match = new RegExp(`<button[^>]*>${label}</button>`).exec(html);
  expect(match).not.toBeNull();
  return (match as RegExpExecArray)[0];
};

describe('LoginCodeStep', () => {
  it('says where the code went, masked', () => {
    expect(render()).toContain('We emailed a 6-digit code to <strong>ju***@gmail.com</strong>');
  });

  it('says plainly when no code went out', () => {
    // react-dom/server escapes the apostrophe.
    expect(render({ sentTo: null })).toContain('We couldn&#x27;t email you a code yet.');
  });

  it('has one numeric one-time-code input of six characters', () => {
    const html = render();
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain('autoComplete="one-time-code"');
    expect(html).toContain('maxLength="6"');
  });

  it('keeps Verify disabled until six digits are in', () => {
    expect(buttonTag(render({ code: '12345' }), 'VERIFY')).toContain('disabled');
    expect(buttonTag(render({ code: '123456' }), 'VERIFY')).not.toContain('disabled');
  });

  it('shows VERIFYING… and stays disabled while a check is in flight', () => {
    expect(buttonTag(render({ code: '123456', verifying: true }), 'VERIFYING…')).toContain(
      'disabled',
    );
  });

  it('counts down Resend and disables it until then', () => {
    expect(buttonTag(render({ resendSecondsLeft: 42 }), 'Resend code in 0:42')).toContain(
      'disabled',
    );
    expect(buttonTag(render({ resendSecondsLeft: 0 }), 'Resend code')).not.toContain('disabled');
  });

  it('shows the error as an alert, in words', () => {
    const html = render({ error: "That code isn't right. 3 tries left." });
    expect(html).toContain('role="alert"');
    expect(html).toContain('That code isn&#x27;t right. 3 tries left.');
  });

  it('offers a way out to another account', () => {
    expect(buttonTag(render(), 'Use a different account')).not.toContain('disabled');
  });
});
