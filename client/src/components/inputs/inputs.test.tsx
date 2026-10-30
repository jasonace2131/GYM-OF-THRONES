import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { PhoneInput } from './PhoneInput';
import { NameInput } from './NameInput';
import { EmailInput } from './EmailInput';
import { CharCounter } from './CharCounter';
import { BirthDateInput } from './BirthDateInput';
import {
  filterDecimalTyping,
  filterIntTyping,
  parseDecimalField,
  parseIntField,
  parsePesosToCentavos,
} from '@/lib/numberInput';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function leave(el: HTMLInputElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function Phone() {
  const [value, setValue] = useState('');
  return <PhoneInput value={value} onChange={setValue} />;
}
function Name() {
  const [value, setValue] = useState('');
  return <NameInput value={value} onChange={setValue} />;
}
function Email() {
  const [value, setValue] = useState('');
  return <EmailInput value={value} onChange={setValue} />;
}
function BirthDate() {
  const [value, setValue] = useState('');
  return <BirthDateInput value={value} onChange={setValue} today="2026-10-30" />;
}

/** Owner, 2026-10-30: nobody under 12 has an account. */
describe('BirthDateInput', () => {
  it('offers only dates the API accepts: 120 years back to the latest 12th birthday', async () => {
    await act(async () => root.render(<BirthDate />));
    const input = container.querySelector('input')!;
    expect(input.type).toBe('date');
    expect(input.min).toBe('1906-10-31');
    expect(input.max).toBe('2014-10-30');
  });

  it("puts the minimum-age sentence in the browser's own bubble for a date after max", async () => {
    await act(async () => root.render(<BirthDate />));
    const input = container.querySelector('input')!;
    await type(input, '2020-06-01');
    expect(input.checkValidity()).toBe(false);
    expect(input.validationMessage).toBe(
      'You need to be at least 12 years old to create an account.',
    );
  });

  it('clears that message once a date that is old enough is picked', async () => {
    await act(async () => root.render(<BirthDate />));
    const input = container.querySelector('input')!;
    await type(input, '2020-06-01');
    input.checkValidity();
    await type(input, '1995-05-05');
    expect(input.checkValidity()).toBe(true);
    expect(input.value).toBe('1995-05-05');
  });
});

describe('PhoneInput', () => {
  it('typing letters into it yields nothing', async () => {
    await act(async () => root.render(<Phone />));
    const input = container.querySelector('input')!;
    await type(input, 'abc');
    expect(input.value).toBe('');
    await type(input, '09a17-1b23 4567');
    expect(input.value).toBe('0917-123 4567');
  });

  it('is a tel field with no browser maxLength (the filter cuts at 16)', async () => {
    await act(async () => root.render(<Phone />));
    const input = container.querySelector('input')!;
    expect(input.type).toBe('tel');
    expect(input.inputMode).toBe('tel');
    expect(input.hasAttribute('maxlength')).toBe(false);
  });

  it.each([
    ['(0917) 123-4567', '0917 123-4567'],
    ['+63  917  123  4567', '+63 917 123 4567'],
  ])('a pasted %j survives as a valid number', async (pasted, kept) => {
    await act(async () => root.render(<Phone />));
    const input = container.querySelector('input')!;
    await type(input, pasted);
    expect(input.value).toBe(kept);
    await leave(input);
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps the caller's aria-describedby and points only at a rendered error", async () => {
    function Described() {
      const [value, setValue] = useState('');
      return <PhoneInput id="p" value={value} onChange={setValue} aria-describedby="hint" />;
    }
    await act(async () => root.render(<Described />));
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-describedby')).toBe('hint');
    await type(input, '12345');
    await leave(input);
    expect(input.getAttribute('aria-describedby')).toBe('hint p-phone-error');
    expect(document.getElementById('p-phone-error')).not.toBeNull();
  });

  it('shows the PH-mobile message after leaving an invalid number, not before', async () => {
    await act(async () => root.render(<Phone />));
    const input = container.querySelector('input')!;
    await type(input, '8123 4567');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    await leave(input);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('PH mobile');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await type(input, '0917 123 4567');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('NameInput', () => {
  it('refuses digits and symbols, keeps accents, collapses on leave', async () => {
    await act(async () => root.render(<Name />));
    const input = container.querySelector('input')!;
    expect(input.maxLength).toBe(60);
    await type(input, ' Niña2  O’Brien_ ');
    expect(input.value).toBe(' Niña  O’Brien ');
    await leave(input);
    expect(input.value).toBe('Niña O’Brien');
  });
});

describe('EmailInput', () => {
  it('is capped at 254 and trimmed on leave', async () => {
    await act(async () => root.render(<Email />));
    const input = container.querySelector('input')!;
    expect(input.maxLength).toBe(254);
    await type(input, ' ana@x.com ');
    await leave(input);
    expect(input.value).toBe('ana@x.com');
  });
});

describe('CharCounter', () => {
  it('shows used/max', async () => {
    await act(async () => root.render(<CharCounter id="c" value="hello" max={500} />));
    expect(container.textContent).toBe('5/500 characters');
    expect(container.querySelector('#c')?.getAttribute('aria-live')).toBe('off');
  });

  it('is announced only in the last tenth', async () => {
    await act(async () => root.render(<CharCounter value={'x'.repeat(450)} max={500} />));
    expect(container.querySelector('[aria-live]')?.getAttribute('aria-live')).toBe('polite');
  });
});

describe('number helpers', () => {
  it('filter what may be typed', () => {
    expect(filterIntTyping('1e5-+3')).toBe('153');
    expect(filterDecimalTyping('12.345.6')).toBe('12.34');
    expect(filterDecimalTyping('-1e2')).toBe('12');
  });

  it('read a blank as null, never 0, and hold the bounds', () => {
    expect(parseIntField('', 0, 10)).toBeNull();
    expect(parseIntField('11', 0, 10)).toBeNull();
    expect(parseIntField('1.5', 0, 10)).toBeNull();
    expect(parseIntField(' 7 ', 0, 10)).toBe(7);
    expect(parseDecimalField('1.234', 0, 10)).toBeNull();
    expect(parseDecimalField('9.99', 0, 10)).toBe(9.99);
    expect(parsePesosToCentavos('1500.5', 100_000)).toBe(150050);
    expect(parsePesosToCentavos('100000.01', 100_000)).toBeNull();
  });
});
