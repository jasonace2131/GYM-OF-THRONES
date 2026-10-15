import type { Plan, PlanKind } from '@prisma/client';

/**
 * The pricing grid's projection. No id, no isActive, no timestamps.
 *
 * `id` is withheld deliberately: every purchase path names a plan by `code` —
 * the column snapshotted onto Membership and Payment — so the uuid buys an
 * unauthenticated page nothing and shipping it invites a client to POST it.
 *
 * Money leaves as an integer number of centavos and nothing else. There is no
 * `priceFormatted`, no `₱`, no locale: rendering is the client's job, and a
 * formatted string on the wire is a second representation of the same number
 * that can disagree with the first.
 */
export interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  kind: PlanKind;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
}

/** Everything above plus the two columns an operator manages the list with. */
export interface AdminPlan extends PublicPlan {
  id: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export function toPublicPlan(row: Plan): PublicPlan {
  return {
    code: row.code,
    name: row.name,
    description: row.description,
    kind: row.kind,
    priceCentavos: row.priceCentavos,
    termMonths: row.termMonths,
    freezable: row.freezable,
    guestPassesPerTerm: row.guestPassesPerTerm,
    graceDays: row.graceDays,
    perks: row.perks,
    sortOrder: row.sortOrder,
  };
}

export function toAdminPlan(row: Plan): AdminPlan {
  return {
    ...toPublicPlan(row),
    id: row.id,
    isActive: row.isActive,
    // Instants, not business dates: these are @db.Timestamptz(3) and travel as
    // full ISO-8601 strings, formatted client-side with an explicit timeZone.
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
