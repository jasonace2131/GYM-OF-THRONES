import type { Station, StationCredential } from '@prisma/client';

/**
 * The admin view of a station.
 *
 * NOTE WHAT IS ABSENT: `keyHash`. It never leaves the database, not even to an
 * ADMIN, because a hash plus a known pepper is an offline guessing target and
 * there is no operational question it answers. `lastUsedIpHash` is absent for
 * the same reason it is hashed in the first place — an IP is personal data
 * under the Data Privacy Act and equality is all the clustering ever needed.
 */
export interface AdminStationCredential {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  /** Derived, so the console renders a state rather than computing one. */
  isActive: boolean;
}

export interface AdminStation {
  id: string;
  code: string;
  name: string;
  gymCode: string;
  tokenEpoch: number;
  isActive: boolean;
  lastTokenIssuedAt: string | null;
  /** Lifetime admissions opened at this station. */
  checkInCount: number;
  credentials: AdminStationCredential[];
}

/** Returned exactly once, at issue. The secret is never recoverable after this. */
export interface IssuedStationCredential {
  credential: AdminStationCredential;
  /** Plaintext. Shown once, stored nowhere, never logged. */
  secret: string;
  /** So the console can tell staff which tablet this belongs to. */
  stationCode: string;
}

export function toAdminStationCredential(row: StationCredential): AdminStationCredential {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    isActive: row.revokedAt === null,
  };
}

export function toAdminStation(
  row: Station & { credentials: StationCredential[]; _count: { checkIns: number } },
): AdminStation {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    gymCode: row.gymCode,
    tokenEpoch: row.tokenEpoch,
    isActive: row.isActive,
    lastTokenIssuedAt: row.lastTokenIssuedAt?.toISOString() ?? null,
    checkInCount: row._count.checkIns,
    credentials: row.credentials.map(toAdminStationCredential),
  };
}
