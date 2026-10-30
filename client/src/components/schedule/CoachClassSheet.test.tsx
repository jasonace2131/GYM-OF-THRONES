import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { session } from '@/lib/schedule/fixtures';
import { CoachCancelClassDialog, CoachClassSheet } from './CoachClassSheet';

/** A coach's own class: the form and the cancel dialog (owner, 2026-10-23). */

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

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((b) => b.textContent === label);
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

describe('CoachClassSheet', () => {
  it('names the coach as the caller, checks the form, then hands over the draft', async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(
        <CoachClassSheet
          open
          session={null}
          day="2026-09-18"
          coachName="Ana Cruz"
          busy={false}
          error={null}
          onSave={onSave}
          onClose={() => {}}
        />,
      );
    });

    expect(document.body.textContent).toContain('Coach: Ana Cruz (you)');
    expect(document.querySelector('select')).toBeNull();

    await act(async () => button('Put it on the timetable').click());
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Give the class a name.');

    await type(document.querySelector<HTMLInputElement>('input[placeholder="HIIT Conditioning"]')!, 'Yoga');
    await act(async () => button('Put it on the timetable').click());
    expect(onSave).toHaveBeenCalledWith({
      title: 'Yoga',
      date: '2026-09-18',
      start: '18:00',
      minutes: 60,
      capacity: 16,
      repeat: false,
      weeks: 4,
    });
  });

  it('repeats a new class weekly, saying when, and hands over the weeks', async () => {
    const onSave = vi.fn();
    await act(async () => {
      root.render(
        <CoachClassSheet
          open
          session={null}
          day="2026-09-17"
          coachName="Ana Cruz"
          busy={false}
          error={null}
          onSave={onSave}
          onClose={() => {}}
        />,
      );
    });
    const repeat = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(repeat).toHaveLength(1);
    expect(repeat[0]?.checked).toBe(false);
    expect(document.body.textContent).not.toContain('Every Thursday');

    await act(async () => repeat[0]?.click());
    // Thu 17 Sep at 6pm, four weeks: the last is Thu 8 Oct.
    expect(document.body.textContent).toContain(
      'Every Thursday at 6:00 PM, 4 classes, last on 8 Oct',
    );
    const weeks = document.querySelector<HTMLInputElement>('input[max="12"]')!;
    await type(weeks, '6');
    expect(document.body.textContent).toContain('6 classes, last on 22 Oct');

    await type(document.querySelector<HTMLInputElement>('input[placeholder="HIIT Conditioning"]')!, 'Yoga');
    await act(async () => button('Put them on the timetable').click());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ repeat: true, weeks: 6 }));
  });

  it('offers no repeat when editing one class', async () => {
    await act(async () => {
      root.render(
        <CoachClassSheet
          open
          session={session({})}
          day="2026-09-14"
          coachName="Ana Cruz"
          busy={false}
          error={null}
          onSave={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.body.textContent).not.toContain('Repeat weekly');
  });

  it("shows the server's sentence after a refused save", async () => {
    await act(async () => {
      root.render(
        <CoachClassSheet
          open
          session={session({})}
          day="2026-09-14"
          coachName="Ana Cruz"
          busy={false}
          error="That start time has already passed. Check the date and the time."
          onSave={() => {}}
          onClose={() => {}}
        />,
      );
    });
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'That start time has already passed. Check the date and the time.',
    );
    expect(button('Save changes')).toBeTruthy();
  });
});

describe('CoachCancelClassDialog', () => {
  it('needs a reason before it cancels, and sends it trimmed', async () => {
    const onConfirm = vi.fn();
    const target = session({});
    await act(async () => {
      root.render(
        <CoachCancelClassDialog
          session={target}
          busy={false}
          error={null}
          onConfirm={onConfirm}
          onClose={() => {}}
        />,
      );
    });
    expect(button('Cancel class').disabled).toBe(true);
    await type(document.querySelector('textarea')!, '  Coach is unwell  ');
    await act(async () => button('Cancel class').click());
    expect(onConfirm).toHaveBeenCalledWith(target, 'Coach is unwell');
  });

  it("never carries one class's reason into the next class's dialog", async () => {
    const draw = async (target: ReturnType<typeof session> | null): Promise<void> => {
      await act(async () => {
        root.render(
          <CoachCancelClassDialog
            session={target}
            busy={false}
            error={null}
            onConfirm={() => {}}
            onClose={() => {}}
          />,
        );
      });
    };
    await draw(session({ id: 'first' }));
    await type(document.querySelector('textarea')!, 'Coach is unwell');
    // The page closes it by clearing the target (onOpenChange never fires)…
    await draw(null);
    // …and the next class opens blank.
    await draw(session({ id: 'second', title: 'Yoga' }));
    expect(document.querySelector('textarea')?.value).toBe('');
    expect(button('Cancel class').disabled).toBe(true);
  });
});
