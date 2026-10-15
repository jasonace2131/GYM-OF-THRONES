import { afterEach, describe, expect, it } from 'vitest';
import { isTopOverlay, pushOverlay, removeOverlay } from './overlayStack';

describe('overlayStack', () => {
  const opened: symbol[] = [];
  const open = (): symbol => {
    const id = pushOverlay();
    opened.push(id);
    return id;
  };

  afterEach(() => {
    for (const id of opened.splice(0)) removeOverlay(id);
  });

  it('makes the most recently opened overlay the one that owns the keyboard', () => {
    const form = open();
    expect(isTopOverlay(form)).toBe(true);

    const confirm = open();
    expect(isTopOverlay(confirm)).toBe(true);
    expect(isTopOverlay(form)).toBe(false);
  });

  it('hands the keyboard back when the top overlay closes', () => {
    const drawer = open();
    const confirm = open();

    removeOverlay(confirm);

    expect(isTopOverlay(drawer)).toBe(true);
  });

  it('removes an overlay that is not on top without disturbing the order', () => {
    const a = open();
    const b = open();
    const c = open();

    removeOverlay(b);

    expect(isTopOverlay(c)).toBe(true);
    removeOverlay(c);
    expect(isTopOverlay(a)).toBe(true);
  });

  it('treats a missing id as never on top, and removing it twice as harmless', () => {
    const a = open();
    removeOverlay(a);
    removeOverlay(a);

    expect(isTopOverlay(a)).toBe(false);
    expect(isTopOverlay(null)).toBe(false);
  });
});
