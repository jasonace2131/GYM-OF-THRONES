import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Admin → Settings → Equipment, driven in jsdom with the API mocked. */

const { adminApi } = vi.hoisted(() => ({
  adminApi: {
    equipment: vi.fn(),
    addEquipment: vi.fn(),
    updateEquipment: vi.fn(),
    removeEquipment: vi.fn(),
    reorderEquipment: vi.fn(),
  },
}));

vi.mock('@/lib/adminApi', () => ({ adminApi }));
vi.mock('@/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  apiFetch: vi.fn(),
}));

import { EquipmentCard } from './EquipmentCard';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = { id: 'a', name: 'Dumbbells', detail: '2–40 kg pairs', sortOrder: 0 };
const B = { id: 'b', name: 'Flat bench', detail: null, sortOrder: 1 };

let container: HTMLDivElement;
let root: Root;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

async function render(items: unknown[]): Promise<void> {
  adminApi.equipment.mockResolvedValue(items);
  await act(async () => {
    root.render(<EquipmentCard />);
  });
  await flush();
}

const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find(
    (b) => b.textContent === label || b.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`no button ${label}`);
  return found;
};

async function type(el: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await flush();
}

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

describe('EquipmentCard', () => {
  it('says what an empty list means for the AI', async () => {
    await render([]);
    expect(container.textContent).toContain(
      'No equipment listed. The AI plans with bodyweight and common gym basics until you add some.',
    );
  });

  it('adds a trimmed item and reloads', async () => {
    await render([A]);
    adminApi.addEquipment.mockResolvedValue({ ...B });
    await type(container.querySelector('[aria-label="New equipment name"]')!, '  Rower ');
    await click(button('Add equipment'));
    expect(adminApi.addEquipment).toHaveBeenCalledWith({ name: 'Rower', detail: null });
    expect(adminApi.equipment).toHaveBeenCalledTimes(2);
  });

  it('refuses a duplicate name before calling the API', async () => {
    await render([A]);
    await type(container.querySelector('[aria-label="New equipment name"]')!, 'dumbbells');
    await click(button('Add equipment'));
    expect(adminApi.addEquipment).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'That equipment is already on the list.',
    );
  });

  it('edits inline', async () => {
    await render([A, B]);
    adminApi.updateEquipment.mockResolvedValue(A);
    await click([...container.querySelectorAll('button')].find((b) => b.textContent === 'Edit')!);
    await type(container.querySelector('[aria-label="Detail for Dumbbells"]')!, '2–50 kg');
    await click(button('Save'));
    expect(adminApi.updateEquipment).toHaveBeenCalledWith('a', {
      name: 'Dumbbells',
      detail: '2–50 kg',
    });
  });

  it('moves an item down with the whole order', async () => {
    await render([A, B]);
    adminApi.reorderEquipment.mockResolvedValue([B, A]);
    expect(button('Move Dumbbells up').disabled).toBe(true);
    await click(button('Move Dumbbells down'));
    expect(adminApi.reorderEquipment).toHaveBeenCalledWith(['b', 'a']);
  });

  it('deletes only after the confirm', async () => {
    await render([A]);
    adminApi.removeEquipment.mockResolvedValue({ removed: true });
    await click(button('Delete'));
    expect(adminApi.removeEquipment).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Delete “Dumbbells”?');
    const confirm = [...document.querySelectorAll('[role="dialog"] button')].find(
      (b) => b.textContent === 'Delete',
    ) as HTMLButtonElement;
    await click(confirm);
    expect(adminApi.removeEquipment).toHaveBeenCalledWith('a');
  });
});
