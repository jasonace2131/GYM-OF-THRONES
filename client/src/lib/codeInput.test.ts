import { describe, expect, it } from 'vitest';
import { filterCodeTyping } from './codeInput';

describe('filterCodeTyping', () => {
  it('upper-cases and maps the look-alikes: O→0, I/L→1', () => {
    expect(filterCodeTyping('6oedym', 6)).toBe('60EDYM');
    expect(filterCodeTyping('il9k', 4)).toBe('119K');
  });

  it('drops U and anything outside the alphabet, and cuts at the length', () => {
    expect(filterCodeTyping('a-u b#c', 6)).toBe('ABC');
    expect(filterCodeTyping('ABCDEFGH', 6)).toBe('ABCDEF');
  });
});
