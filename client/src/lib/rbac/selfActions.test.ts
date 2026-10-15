import { describe, expect, it } from 'vitest';
import { allowedOnMember } from './selfActions';

const ME = '6a0c1b2e-0000-4000-8000-000000000001';
const OTHER = '6a0c1b2e-0000-4000-8000-000000000002';

/**
 * Nobody changes their own role, suspends or deletes themselves from the
 * console (owner decision). The row is still theirs to edit.
 */
describe('allowedOnMember', () => {
  it.each(['role', 'suspend', 'reactivate', 'delete'] as const)(
    'hides %s on your own row',
    (action) => {
      expect(allowedOnMember(action, ME, ME)).toBe(false);
      expect(allowedOnMember(action, ME, OTHER)).toBe(true);
    },
  );

  it('still lets you edit your own profile', () => {
    expect(allowedOnMember('edit', ME, ME)).toBe(true);
  });

  /** Unknown caller (profile not loaded) — fail closed on the dangerous ones. */
  it('refuses the self-forbidden actions while the caller is unknown', () => {
    expect(allowedOnMember('delete', null, OTHER)).toBe(false);
    expect(allowedOnMember('role', undefined, OTHER)).toBe(false);
    expect(allowedOnMember('edit', null, OTHER)).toBe(true);
  });
});
