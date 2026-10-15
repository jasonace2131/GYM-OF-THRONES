import { describe, expect, it } from 'vitest';
import {
  STAFF_QR_PATH,
  authFailureFor,
  chooseStationCredential,
  staffLoginPath,
  stationAuthHeaders,
  stationCodeFor,
  stationModeFrom,
} from './stationAuth';

describe('stationModeFrom', () => {
  it('is staff only for ?mode=staff, exactly', () => {
    expect(stationModeFrom('staff')).toBe('staff');
    expect(stationModeFrom(null)).toBe('tablet');
    expect(stationModeFrom('')).toBe('tablet');
    expect(stationModeFrom('STAFF')).toBe('tablet');
    expect(stationModeFrom('admin')).toBe('tablet');
  });
});

describe('chooseStationCredential', () => {
  it('sends the tablet key on a provisioned tablet', () => {
    expect(
      chooseStationCredential({ mode: 'tablet', stationKey: 'k-123', accessToken: null }),
    ).toEqual({ kind: 'SEND', credential: { kind: 'STATION_KEY', key: 'k-123' } });
  });

  it('never sends a staff token from the tablet display, even when a session exists', () => {
    // A lobby tablet must not start depending on somebody's login that
    // expires overnight — the key is its only credential.
    expect(
      chooseStationCredential({ mode: 'tablet', stationKey: 'k-123', accessToken: 'jwt' }),
    ).toEqual({ kind: 'SEND', credential: { kind: 'STATION_KEY', key: 'k-123' } });
  });

  it('asks for setup on a tablet with no key', () => {
    expect(chooseStationCredential({ mode: 'tablet', stationKey: null, accessToken: 'jwt' })).toEqual(
      { kind: 'UNCONFIGURED' },
    );
    expect(chooseStationCredential({ mode: 'tablet', stationKey: '  ', accessToken: null })).toEqual({
      kind: 'UNCONFIGURED',
    });
  });

  it("sends the staff member's own session in staff mode", () => {
    expect(
      chooseStationCredential({ mode: 'staff', stationKey: null, accessToken: 'jwt-abc' }),
    ).toEqual({ kind: 'SEND', credential: { kind: 'STAFF_SESSION', accessToken: 'jwt-abc' } });
  });

  it('never sends a stored tablet key in staff mode — the session is the credential', () => {
    expect(
      chooseStationCredential({ mode: 'staff', stationKey: 'k-123', accessToken: 'jwt-abc' }),
    ).toEqual({ kind: 'SEND', credential: { kind: 'STAFF_SESSION', accessToken: 'jwt-abc' } });
  });

  it('is signed out in staff mode with no session, even on a provisioned tablet', () => {
    expect(chooseStationCredential({ mode: 'staff', stationKey: 'k-123', accessToken: null })).toEqual({
      kind: 'SIGNED_OUT',
    });
    expect(chooseStationCredential({ mode: 'staff', stationKey: null, accessToken: '' })).toEqual({
      kind: 'SIGNED_OUT',
    });
  });
});

describe('stationAuthHeaders', () => {
  it('puts the tablet key in X-Station-Key and nothing else', () => {
    expect(stationAuthHeaders({ kind: 'STATION_KEY', key: 'k-123' })).toEqual({
      'X-Station-Key': 'k-123',
    });
  });

  it('puts the staff session in a Bearer Authorization header and nothing else', () => {
    // Sending X-Station-Key as well would make the guard take the tablet path.
    expect(stationAuthHeaders({ kind: 'STAFF_SESSION', accessToken: 'jwt-abc' })).toEqual({
      Authorization: 'Bearer jwt-abc',
    });
  });
});

describe('authFailureFor', () => {
  it('is not an auth failure for anything but 401 and 403', () => {
    expect(authFailureFor('STATION_KEY', 200)).toBeNull();
    expect(authFailureFor('STAFF_SESSION', 410)).toBeNull();
    expect(authFailureFor('STAFF_SESSION', 500)).toBeNull();
  });

  it('reads either refusal of a tablet key as revoked', () => {
    expect(authFailureFor('STATION_KEY', 401)).toBe('REVOKED');
    expect(authFailureFor('STATION_KEY', 403)).toBe('REVOKED');
  });

  it('reads a 401 on a staff session as an expired login, and a 403 as not permitted', () => {
    expect(authFailureFor('STAFF_SESSION', 401)).toBe('SESSION_EXPIRED');
    expect(authFailureFor('STAFF_SESSION', 403)).toBe('FORBIDDEN');
  });
});

describe('stationCodeFor', () => {
  it('uses the code stored on the tablet in tablet mode', () => {
    expect(stationCodeFor({ mode: 'tablet', storedCode: 'ZDQA', param: 'XXXX' })).toBe('ZDQA');
    expect(stationCodeFor({ mode: 'tablet', storedCode: null, param: 'XXXX' })).toBeNull();
  });

  it('uses ?station= in staff mode, never a code left behind by a tablet setup', () => {
    expect(stationCodeFor({ mode: 'staff', storedCode: 'ZDQA', param: 'k9pq' })).toBe('K9PQ');
    expect(stationCodeFor({ mode: 'staff', storedCode: 'ZDQA', param: null })).toBeNull();
    expect(stationCodeFor({ mode: 'staff', storedCode: null, param: '  ' })).toBeNull();
  });
});

describe('staffLoginPath', () => {
  it('returns to the staff display after signing in', () => {
    expect(STAFF_QR_PATH).toBe('/desk/station?mode=staff');
    expect(staffLoginPath()).toBe('/login?next=%2Fdesk%2Fstation%3Fmode%3Dstaff');
  });
});
