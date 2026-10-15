import { describe, expect, it } from 'vitest';
import { characterCount, checkInstructions, counterLabel, editedLabel } from './assistantSettings';

describe('checkInstructions', () => {
  it('cannot save an unchanged draft', () => {
    expect(checkInstructions('Be brief.', 'Be brief.', 6000)).toMatchObject({
      dirty: false,
      canSave: false,
    });
  });

  it('treats whitespace at the ends as no change, because the server trims', () => {
    expect(checkInstructions('  Be brief.\n', 'Be brief.', 6000).dirty).toBe(false);
  });

  it('can save a real change', () => {
    expect(checkInstructions('Be very brief.', 'Be brief.', 6000)).toMatchObject({
      dirty: true,
      blank: false,
      tooLong: false,
      canSave: true,
    });
  });

  it('cannot save a blank draft', () => {
    expect(checkInstructions(' \n\t ', 'Be brief.', 6000)).toMatchObject({
      blank: true,
      canSave: false,
    });
  });

  it('allows exactly the limit and blocks one character over', () => {
    expect(checkInstructions('a'.repeat(6000), '', 6000).canSave).toBe(true);
    expect(checkInstructions('a'.repeat(6001), '', 6000)).toMatchObject({
      tooLong: true,
      canSave: false,
    });
  });

  it('counts an emoji as one character, as the server does', () => {
    expect(characterCount('💪💪💪')).toBe(3);
    expect(checkInstructions('💪'.repeat(6000), '', 6000).canSave).toBe(true);
  });
});

describe('counterLabel', () => {
  it('groups thousands', () => {
    expect(counterLabel(1234, 6000)).toBe('1,234 / 6,000');
  });
});

describe('editedLabel', () => {
  it('says when the built-in default is in use', () => {
    expect(editedLabel({ isDefault: true, updatedAt: null, updatedByName: null })).toBe(
      'Built-in default',
    );
  });

  it('names the editor and the gym-local date', () => {
    expect(
      editedLabel({
        isDefault: false,
        updatedAt: '2026-10-14T03:00:00.000Z',
        updatedByName: 'Ana Cruz',
      }),
    ).toMatch(/^Edited by Ana Cruz · .*14.*2026$/);
  });

  it('still reads when the editor account is gone', () => {
    expect(
      editedLabel({ isDefault: false, updatedAt: '2026-10-14T03:00:00.000Z', updatedByName: null }),
    ).toMatch(/^Edited by a former staff account · /);
  });
});
