import { hashIp, ipInAnyCidr, isOffSiteOrigin, parseCidr, parseCidrList, parseIp } from './origin';

describe('parseCidrList', () => {
  it('parses a comma-separated list with surrounding whitespace', () => {
    const ranges = parseCidrList(' 203.0.113.0/24 , 198.51.100.7 ');
    expect(ranges).toHaveLength(2);
    expect(ranges[0].prefixBits).toBe(24);
    // A bare address is a host route, not a wildcard.
    expect(ranges[1].prefixBits).toBe(32);
  });

  it('returns an empty list for the empty string — which is legal', () => {
    expect(parseCidrList('')).toEqual([]);
    expect(parseCidrList('   ')).toEqual([]);
  });

  /**
   * The load-bearing one. This list is operator-typed configuration read at
   * boot; a typo must degrade the signal, never refuse to start the API.
   */
  it('drops unparseable entries instead of throwing', () => {
    const ranges = parseCidrList('203.0.113.0/24, not-an-ip, 10.0.0.0/99, 999.1.1.1/8');
    expect(ranges).toHaveLength(1);
    expect(ranges[0].prefixBits).toBe(24);
  });

  it('parses IPv6 ranges', () => {
    const range = parseCidr('2001:db8::/32');
    expect(range?.prefixBits).toBe(32);
    expect(range?.bytes).toHaveLength(16);
  });
});

describe('parseIp', () => {
  it('reads a dotted quad', () => {
    expect(Array.from(parseIp('203.0.113.5')!)).toEqual([203, 0, 113, 5]);
  });

  /**
   * Express renders an IPv4 client behind an IPv6 socket as '::ffff:1.2.3.4'.
   * Treating that as sixteen bytes makes every IPv4 CIDR in the allowlist
   * silently never match — the whole exemption quietly stops working and
   * nothing fails loudly.
   */
  it('unwraps the IPv4-mapped IPv6 form to four bytes', () => {
    expect(Array.from(parseIp('::ffff:203.0.113.5')!)).toEqual([203, 0, 113, 5]);
  });

  it('expands :: in an IPv6 address', () => {
    const bytes = parseIp('2001:db8::1')!;
    expect(bytes).toHaveLength(16);
    expect(bytes[0]).toBe(0x20);
    expect(bytes[1]).toBe(0x01);
    expect(bytes[15]).toBe(1);
  });

  it('rejects malformed input rather than coercing it', () => {
    for (const bad of ['', '1.2.3', '1.2.3.4.5', '256.0.0.1', '01.2.3.4', '1e2.0.0.1', 'zz::1']) {
      expect(parseIp(bad)).toBeNull();
    }
  });
});

describe('ipInAnyCidr', () => {
  const gym = parseCidrList('203.0.113.0/24, 2001:db8::/32');

  it('matches inside the prefix and misses outside it', () => {
    expect(ipInAnyCidr('203.0.113.99', gym)).toBe(true);
    expect(ipInAnyCidr('203.0.114.1', gym)).toBe(false);
  });

  it('honours a partial-byte prefix', () => {
    const ranges = parseCidrList('10.0.0.0/12');
    expect(ipInAnyCidr('10.15.255.255', ranges)).toBe(true);
    expect(ipInAnyCidr('10.16.0.0', ranges)).toBe(false);
  });

  it('matches an IPv4 client arriving in mapped form', () => {
    expect(ipInAnyCidr('::ffff:203.0.113.99', gym)).toBe(true);
  });

  it('never matches across address families', () => {
    expect(ipInAnyCidr('2001:db8::1', parseCidrList('203.0.113.0/24'))).toBe(false);
    expect(ipInAnyCidr('203.0.113.1', parseCidrList('2001:db8::/32'))).toBe(false);
  });

  it('matches IPv6 inside its prefix', () => {
    expect(ipInAnyCidr('2001:db8:dead:beef::1', gym)).toBe(true);
    expect(ipInAnyCidr('2001:db9::1', gym)).toBe(false);
  });

  it('treats an absent or unparseable IP as outside every range', () => {
    expect(ipInAnyCidr(undefined, gym)).toBe(false);
    expect(ipInAnyCidr('nonsense', gym)).toBe(false);
  });
});

describe('isOffSiteOrigin', () => {
  /**
   * The documented degenerate case: with no allowlist configured, every
   * request reads as off-site. That degrades the signal to noise — it must
   * never degrade anything else, which is why nothing in this module returns
   * a decision.
   */
  it('is true for everything when the allowlist is empty', () => {
    expect(isOffSiteOrigin('203.0.113.5', parseCidrList(''))).toBe(true);
  });

  it('is false for an address inside gym egress', () => {
    expect(isOffSiteOrigin('203.0.113.5', parseCidrList('203.0.113.0/24'))).toBe(false);
  });
});

describe('hashIp', () => {
  it('produces exactly 64 lowercase hex characters, as @db.Char(64) requires', () => {
    expect(hashIp('203.0.113.5', 'pepper'.repeat(6))).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable for one address and separates two', () => {
    const pepper = 'pepper'.repeat(6);
    expect(hashIp('203.0.113.5', pepper)).toBe(hashIp('203.0.113.5', pepper));
    expect(hashIp('203.0.113.5', pepper)).not.toBe(hashIp('203.0.113.6', pepper));
  });

  /** The pepper is the whole defence against a rainbow walk over IPv4. */
  it('changes completely when the pepper changes', () => {
    expect(hashIp('203.0.113.5', 'a'.repeat(32))).not.toBe(hashIp('203.0.113.5', 'b'.repeat(32)));
  });

  it('hashes a stable sentinel rather than throwing when the IP is absent', () => {
    expect(hashIp(undefined, 'p'.repeat(32))).toMatch(/^[0-9a-f]{64}$/);
  });
});
