/**
 * The gym's equipment list (owner, 2026-10-23) — edited in Admin → Settings,
 * read by the AI planners as data. `/admin/equipment`.
 */

export const GYM_EQUIPMENT_LIMITS = { nameMax: 80, detailMax: 120 } as const;

export interface GymEquipmentItem {
  id: string;
  /** "Dumbbells". Unique, ignoring case. */
  name: string;
  /** "2–40 kg pairs", or null. */
  detail: string | null;
  sortOrder: number;
}

/** `POST /admin/equipment` and `PATCH /admin/equipment/:id`. */
export interface GymEquipmentInput {
  name: string;
  /** Empty or null clears it. */
  detail?: string | null;
}
