import { describe, expect, it } from 'vitest';
import { seedFromGuest } from './memberSeed';

describe('seedFromGuest', () => {
  it('pre-fills the email the walk-in gave, so the desk types nothing twice', () => {
    expect(
      seedFromGuest({
        guestName: 'Ana Maria Cruz',
        guestPhone: '09171234567',
        guestEmail: 'ana@example.com',
        guestEmergencyContact: 'Maria 0917',
      }),
    ).toEqual({
      firstName: 'Ana',
      lastName: 'Maria Cruz',
      email: 'ana@example.com',
      phone: '09171234567',
      emergencyContact: 'Maria 0917',
    });
  });

  it('leaves the email blank for an older visit that never recorded one', () => {
    expect(
      seedFromGuest({
        guestName: 'Ana',
        guestPhone: null,
        guestEmail: null,
        guestEmergencyContact: null,
      }),
    ).toEqual({ firstName: 'Ana', lastName: '', email: '', phone: '', emergencyContact: '' });
  });
});
