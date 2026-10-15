import { createHash } from 'node:crypto';

/**
 * The network-origin signal (§6.11.2), and nothing else.
 *
 * Pure: no Prisma, no config read, no clock. Everything here is a parameter,
 * because the one property that matters — `offSiteOrigin` DENIES NOBODY — is
 * only checkable if the whole thing is testable without a request.
 *
 * WHY THIS EXISTS. The strongest attack on a rotating station QR is not a
 * photograph; it is one cheap device with a camera aimed at the display,
 * decoding every slot and republishing it. Against that the 30-60 s TTL is
 * irrelevant (every relayed token is fresh) and `tokenStalenessSeconds` is
 * zero — so the relay's signature reads BETTER than a legitimate member on a
 * poor connection. The one signal a live relay cannot evade is that its
 * consumers are on other networks.
 *
 * WHY IT NEVER DENIES. Members on cellular inside the building are entirely
 * legitimate — the gym's own AP is a launch requirement, not a guarantee — and
 * denying on network origin turns a signal into an outage. It is surfaced as a
 * quiet chip on the desk feed and counted nightly. That is the whole contract.
 *
 * WHY THE IP IS HASHED. A member's IP address is personal data under the Data
 * Privacy Act, and clustering only ever needs equality. The pepper means a
 * leaked database does not yield a rainbow-table walk over the ~4 billion IPv4
 * addresses, which an unpeppered SHA-256 of an IP would.
 */

export interface CidrRange {
  /** Big-endian bytes of the network address. 4 for IPv4, 16 for IPv6. */
  bytes: Uint8Array;
  prefixBits: number;
}

/**
 * `'203.0.113.0/24, 2001:db8::/32'` → ranges. Unparseable entries are DROPPED
 * rather than thrown on: this list is operator-typed configuration read at
 * boot, and a typo in it must degrade the signal, never refuse to start the
 * API. An empty string yields an empty list, which is legal and documented —
 * it means "every request looks off-site".
 */
export function parseCidrList(raw: string): CidrRange[] {
  const out: CidrRange[] = [];
  for (const entry of raw.split(',')) {
    const range = parseCidr(entry.trim());
    if (range !== null) out.push(range);
  }
  return out;
}

export function parseCidr(entry: string): CidrRange | null {
  if (entry.length === 0) return null;

  const slash = entry.lastIndexOf('/');
  const address = slash === -1 ? entry : entry.slice(0, slash);
  const bytes = parseIp(address);
  if (bytes === null) return null;

  const maxBits = bytes.length * 8;
  if (slash === -1) return { bytes, prefixBits: maxBits };

  const prefixBits = Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefixBits) || prefixBits < 0 || prefixBits > maxBits) return null;
  return { bytes, prefixBits };
}

/**
 * `true` when `ip` falls inside ANY range. An unparseable or absent IP is
 * `false` — off-site — which is the safe direction: it costs a false chip on
 * the feed, never an admission.
 */
export function ipInAnyCidr(ip: string | undefined, ranges: readonly CidrRange[]): boolean {
  if (ip === undefined) return false;
  const bytes = parseIp(ip);
  if (bytes === null) return false;
  return ranges.some((range) => matches(bytes, range));
}

/** `offSiteOrigin` — the column, stated as the predicate it actually is. */
export function isOffSiteOrigin(ip: string | undefined, ranges: readonly CidrRange[]): boolean {
  return !ipInAnyCidr(ip, ranges);
}

/**
 * The stored form. Always 64 lowercase hex characters, which is exactly what
 * `@db.Char(64)` expects — a shorter value would be space-padded by Postgres
 * and stop comparing equal to itself.
 */
export function hashIp(ip: string | undefined, pepper: string): string {
  return createHash('sha256')
    .update(`${ip ?? 'unknown'}${pepper}`)
    .digest('hex');
}

function matches(bytes: Uint8Array, range: CidrRange): boolean {
  // An IPv4 address is never inside an IPv6 range and vice versa. Express's
  // `req.ip` renders an IPv4 client behind an IPv6 socket as '::ffff:1.2.3.4',
  // which parseIp already unwraps to its 4 bytes, so the two families only
  // ever meet here as a genuine mismatch.
  if (bytes.length !== range.bytes.length) return false;

  const wholeBytes = range.prefixBits >> 3;
  for (let i = 0; i < wholeBytes; i += 1) {
    if (bytes[i] !== range.bytes[i]) return false;
  }

  const remainingBits = range.prefixBits & 7;
  if (remainingBits === 0) return true;

  const mask = 0xff << (8 - remainingBits);
  return (bytes[wholeBytes] & mask) === (range.bytes[wholeBytes] & mask);
}

/** IPv4, IPv6 and the IPv4-mapped IPv6 form Express hands back behind a proxy. */
export function parseIp(value: string): Uint8Array | null {
  const address = value.trim();
  if (address.length === 0) return null;

  // '::ffff:203.0.113.5' is an IPv4 client, and treating it as 16 bytes would
  // make every IPv4 CIDR in the allowlist silently never match.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return parseIpv4(mapped[1]);

  if (address.includes(':')) return parseIpv6(address);
  return parseIpv4(address);
}

function parseIpv4(value: string): Uint8Array | null {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const bytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) {
    // Reject '01', '+1', '1e2' and '' — Number() accepts several of those and
    // would map two distinct strings onto one address.
    if (!/^(0|[1-9]\d{0,2})$/.test(parts[i])) return null;
    const octet = Number(parts[i]);
    if (octet > 255) return null;
    bytes[i] = octet;
  }
  return bytes;
}

function parseIpv6(value: string): Uint8Array | null {
  const halves = value.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];

  // A trailing dotted-quad ('::ffff:1.2.3.4' handled above, but also
  // '2001:db8::1.2.3.4') expands to two groups.
  const expand = (groups: string[]): string[] | null => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    if (!last.includes('.')) return groups;
    const quad = parseIpv4(last);
    if (quad === null) return null;
    const hi = ((quad[0] << 8) | quad[1]).toString(16);
    const lo = ((quad[2] << 8) | quad[3]).toString(16);
    return [...groups.slice(0, -1), hi, lo];
  };

  const headGroups = expand(head);
  const tailGroups = expand(tail);
  if (headGroups === null || tailGroups === null) return null;

  const explicit = headGroups.length + tailGroups.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;

  const groups = [...headGroups, ...Array.from({ length: 8 - explicit }, () => '0'), ...tailGroups];

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    const group = parseInt(groups[i], 16);
    bytes[i * 2] = group >> 8;
    bytes[i * 2 + 1] = group & 0xff;
  }
  return bytes;
}
