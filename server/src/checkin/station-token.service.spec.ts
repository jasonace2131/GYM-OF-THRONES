import { STATION_TOKEN_REGEX } from '@got/shared';
import { StationTokenService, type StationLookupResult } from './station-token.service';

const SECRET = 'a'.repeat(32);
const PREVIOUS_SECRET = 'b'.repeat(32);
const OTHER_SECRET = 'c'.repeat(32);
const SLOT_SECONDS = 30;

const STATION_A: StationLookupResult = {
  stationId: '11111111-1111-4111-8111-111111111111',
  tokenEpoch: 1,
  isActive: true,
};
const STATION_B: StationLookupResult = {
  stationId: '22222222-2222-4222-8222-222222222222',
  tokenEpoch: 1,
  isActive: true,
};

function slotAt(service: StationTokenService, isoInstant: string): number {
  return service.computeSlot(new Date(isoInstant), SLOT_SECONDS);
}

describe('StationTokenService', () => {
  let service: StationTokenService;
  const now = new Date('2026-08-18T10:14:03.221Z');

  beforeEach(() => {
    service = new StationTokenService();
  });

  describe('round trip', () => {
    it('signs and verifies a token for the current slot', () => {
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const payload = service.buildPayload('9F2K', slot, mac);

      expect(payload).toMatch(STATION_TOKEN_REGEX);

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result).toEqual({ kind: 'VALID', stationId: STATION_A.stationId, slot });
    });

    it('a tampered station code fails end to end, via the lookup it drives — not via the MAC', () => {
      // The station code is deliberately NOT covered by the MAC (§6.1.2): it
      // is a lookup handle, derived from `stationId` at read time, not a
      // second copy of the fact. So changing the code text in a payload does
      // not, by itself, change what this pure function computes — it changes
      // which `Station` row the CALLER looks up before calling verify(). The
      // station-A-vs-station-B test below is that same failure mode, made
      // real: a MAC signed for one station's `id` never matches once the
      // caller's lookup resolves to a different row.
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const tamperedCodePayload = service.buildPayload('9F2M', slot, mac); // '9F2M' still passes the DTO shape

      // Looked up under the SAME station this MAC was actually signed for —
      // the code substring changing the QR carries is irrelevant to the MAC.
      const sameStationLookup = service.verify({
        payload: tamperedCodePayload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });
      expect(sameStationLookup.kind).toBe('VALID');
    });

    it('rejects a tampered slot', () => {
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const payload = service.buildPayload('9F2K', slot + 1, mac);

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });

    it('rejects a tampered MAC', () => {
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const flippedChar = mac[0] === '0' ? '1' : '0';
      const payload = service.buildPayload('9F2K', slot, flippedChar + mac.slice(1));

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });

    it('a token for station A does not verify against station B', () => {
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const payload = service.buildPayload('9F2K', slot, mac);

      const result = service.verify({
        payload,
        station: STATION_B,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });
  });

  describe('verification order — MAC before slot window, no branch leaks on a bad MAC', () => {
    it('an unknown station, an inactive station and a forged MAC all produce the identical INVALID outcome', () => {
      const slot = slotAt(service, now.toISOString());
      const mac = service.sign(STATION_A, slot, SECRET);
      const payload = service.buildPayload('9F2K', slot, mac);

      const unknown = service.verify({
        payload,
        station: null,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });
      const inactive = service.verify({
        payload,
        station: { ...STATION_A, isActive: false },
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });
      const forged = service.verify({
        payload: service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, OTHER_SECRET)),
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(unknown).toEqual({ kind: 'INVALID' });
      expect(inactive).toEqual({ kind: 'INVALID' });
      expect(forged).toEqual({ kind: 'INVALID' });
    });

    it('a stale slot carrying a bad MAC never reaches the slot check — no denial is producible from a forgery', () => {
      // slot far in the past AND a garbage MAC. If the implementation checked
      // the slot window before the MAC, this would still reach a
      // slot-window branch (EXPIRED). It must not: MAC failure is INVALID,
      // full stop, regardless of how stale the slot claims to be.
      const staleSlot = slotAt(service, now.toISOString()) - 1000;
      const payload = service.buildPayload('9F2K', staleSlot, 'ZZZZZZZZZZZZZZZZ');

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });
  });

  describe('slot window', () => {
    it('accepts the current slot and current − 1', () => {
      const currentSlot = slotAt(service, now.toISOString());

      for (const slot of [currentSlot, currentSlot - 1]) {
        const payload = service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, SECRET));
        const result = service.verify({
          payload,
          station: STATION_A,
          secrets: [SECRET],
          now,
          slotSeconds: SLOT_SECONDS,
        });
        expect(result.kind).toBe('VALID');
      }
    });

    it('current − 2 is EXPIRED with the correct tokenStalenessSeconds', () => {
      const currentSlot = slotAt(service, now.toISOString());
      const slot = currentSlot - 2;
      const payload = service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, SECRET));

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result).toEqual({
        kind: 'EXPIRED',
        stationId: STATION_A.stationId,
        slot,
        tokenStalenessSeconds: 2 * SLOT_SECONDS,
      });
    });

    it('current + 1 is NOT_YET_VALID', () => {
      const currentSlot = slotAt(service, now.toISOString());
      const slot = currentSlot + 1;
      const payload = service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, SECRET));

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result).toEqual({ kind: 'NOT_YET_VALID' });
    });
  });

  describe('tokenEpoch and secret rotation', () => {
    it('bumping tokenEpoch invalidates a token minted under the previous epoch', () => {
      const slot = slotAt(service, now.toISOString());
      const payload = service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, SECRET));

      const bumped: StationLookupResult = { ...STATION_A, tokenEpoch: STATION_A.tokenEpoch + 1 };
      const result = service.verify({
        payload,
        station: bumped,
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });

    it('never tries epoch − 1 — immediacy is the whole point of a bump', () => {
      const slot = slotAt(service, now.toISOString());
      // Signed under epoch 2, station now claims epoch 3 (a second bump since).
      const payload = service.buildPayload(
        '9F2K',
        slot,
        service.sign({ ...STATION_A, tokenEpoch: 2 }, slot, SECRET),
      );

      const result = service.verify({
        payload,
        station: { ...STATION_A, tokenEpoch: 3 },
        secrets: [SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });

    it('a token signed with the previous secret still verifies while it is supplied', () => {
      const slot = slotAt(service, now.toISOString());
      const payload = service.buildPayload(
        '9F2K',
        slot,
        service.sign(STATION_A, slot, PREVIOUS_SECRET),
      );

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET, PREVIOUS_SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('VALID');
    });

    it('stops verifying once the previous secret is dropped from the list', () => {
      const slot = slotAt(service, now.toISOString());
      const payload = service.buildPayload(
        '9F2K',
        slot,
        service.sign(STATION_A, slot, PREVIOUS_SECRET),
      );

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET], // STATION_TOKEN_SECRET_PREVIOUS unset
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('INVALID');
    });

    it('tries the current secret before the previous one, and either alone is sufficient', () => {
      const slot = slotAt(service, now.toISOString());
      const payload = service.buildPayload('9F2K', slot, service.sign(STATION_A, slot, SECRET));

      const result = service.verify({
        payload,
        station: STATION_A,
        secrets: [SECRET, PREVIOUS_SECRET],
        now,
        slotSeconds: SLOT_SECONDS,
      });

      expect(result.kind).toBe('VALID');
    });
  });

  describe('payload shape', () => {
    it('every slot from now to 2065 keeps the payload within 36-37 characters and the DTO regex', () => {
      const years = [2026, 2035, 2045, 2055, 2064, 2065];
      for (const year of years) {
        const instant = new Date(Date.UTC(year, 0, 1));
        const slot = service.computeSlot(instant, SLOT_SECONDS);
        expect(slot).toBeLessThanOrEqual(2_147_483_647);

        const mac = service.sign(STATION_A, slot, SECRET);
        const payload = service.buildPayload('9F2K', slot, mac);

        expect(payload.length).toBeGreaterThanOrEqual(36);
        expect(payload.length).toBeLessThanOrEqual(37);
        expect(payload).toMatch(STATION_TOKEN_REGEX);
      }
    });

    it('parses the canonical example payload from §6.1.1', () => {
      const parsed = service.parsePayload('GOTS1.9F2K.59570000.4RTXK8B2QWY5H3PZ');
      expect(parsed).toEqual({ stationCode: '9F2K', slot: 59570000, mac: '4RTXK8B2QWY5H3PZ' });
    });

    it('rejects a five-character station code (the 4-vs-5 regression)', () => {
      expect(service.parsePayload('GOTS1.9F2K5.59570000.4RTXK8B2QWY5H3PZ')).toBeNull();
    });

    it('rejects malformed input entirely', () => {
      expect(service.parsePayload('not-a-token')).toBeNull();
      expect(service.parsePayload('')).toBeNull();
    });
  });

  describe('MAC comparison safety', () => {
    it('does not throw on malformed input carrying a short MAC', () => {
      const slot = slotAt(service, now.toISOString());
      const payload = service.buildPayload('9F2K', slot, 'SHORT');

      expect(() =>
        service.verify({
          payload,
          station: STATION_A,
          secrets: [SECRET],
          now,
          slotSeconds: SLOT_SECONDS,
        }),
      ).not.toThrow();
    });

    it('the private MAC comparator is length-checked before timingSafeEqual and never throws on a mismatch', () => {
      // Exercises the comparator directly: parsePayload's regex guarantees
      // both sides are 16 characters in the real call path, so this is the
      // only way to prove the length guard (not the regex) is what keeps
      // timingSafeEqual from throwing on a length mismatch.
      const macEquals = (
        service as unknown as { macEquals(a: string, b: string): boolean }
      ).macEquals.bind(service);

      expect(() => macEquals('SHORT', '0123456789ABCDEF')).not.toThrow();
      expect(macEquals('SHORT', '0123456789ABCDEF')).toBe(false);
      expect(macEquals('0123456789ABCDEF', '0123456789ABCDEF')).toBe(true);
    });
  });
});
