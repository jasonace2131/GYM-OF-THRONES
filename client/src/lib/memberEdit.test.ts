import { describe, expect, it } from 'vitest';
import { memberEditPatch } from './memberEdit';

const LEGACY = {
  firstName: 'Juan2',
  lastName: 'Dela Cruz',
  phone: '(02) 8123 4567',
  emergencyContact: 'Maria',
};
const form = (patch: Partial<Record<keyof typeof LEGACY, string>> = {}) => ({
  firstName: LEGACY.firstName,
  lastName: LEGACY.lastName,
  phone: LEGACY.phone,
  emergencyContact: LEGACY.emergencyContact,
  ...patch,
});

describe('memberEditPatch', () => {
  it('a legacy name with a digit does not block editing only the phone', () => {
    expect(memberEditPatch(LEGACY, form({ phone: '0917 123 4567' }))).toEqual({
      patch: { phone: '+639171234567' },
      problem: null,
    });
  });

  it('sends nothing when nothing changed, even with legacy values the rules refuse', () => {
    expect(memberEditPatch(LEGACY, form())).toEqual({ patch: {}, problem: null });
  });

  it('checks a name only once it is changed', () => {
    expect(memberEditPatch(LEGACY, form({ firstName: 'Juan3' })).problem).toMatch(/letters/);
    expect(memberEditPatch(LEGACY, form({ firstName: '  Juan  ' })).patch).toEqual({
      firstName: 'Juan',
    });
  });

  it('clears the phone and the emergency contact with null', () => {
    expect(memberEditPatch(LEGACY, form({ phone: ' ', emergencyContact: '' })).patch).toEqual({
      phone: null,
      emergencyContact: null,
    });
  });

  it('refuses a changed phone that is not a PH mobile', () => {
    expect(memberEditPatch(LEGACY, form({ phone: '8123 4567' })).problem).toMatch(/PH mobile/);
  });
});
