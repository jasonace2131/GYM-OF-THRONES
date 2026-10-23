import {
  EMERGENCY_CONTACT_MAX,
  PH_PHONE_MESSAGE,
  collapseSpaces,
  isPersonName,
  normalisePhPhone,
} from '@got/shared';
import { isPlausibleEmail } from '@/lib/guestEmail';
import { saleReferenceProblem } from '@/lib/paymentReference';

/**
 * The one walk-in guest check, shared by `WalkInModal` and `WalkInSheet` so the
 * two counters cannot drift (owner, 2026-10-23): a name by the shared rule
 * with at least two characters, an optional PH mobile, and an optional
 * emergency contact of 2–200 characters. Everything trimmed.
 */
export interface WalkInGuestFields {
  guestName: string;
  guestPhone?: string;
  guestEmergencyContact?: string;
}

export type WalkInGuestCheck =
  | { ok: true; fields: WalkInGuestFields }
  | { ok: false; problem: string };

export function validateWalkInGuest(input: {
  name: string;
  phone: string;
  emergencyContact: string;
}): WalkInGuestCheck {
  const name = collapseSpaces(input.name);
  if (!isPersonName(name, 2)) {
    return {
      ok: false,
      problem: "Enter the guest's name — letters, spaces, apostrophes, hyphens and dots.",
    };
  }
  const phoneTyped = input.phone.trim();
  const phone = phoneTyped === '' ? null : normalisePhPhone(phoneTyped);
  if (phoneTyped !== '' && phone === null) return { ok: false, problem: `${PH_PHONE_MESSAGE}.` };
  const emergency = input.emergencyContact.trim();
  if (emergency !== '' && (emergency.length < 2 || emergency.length > EMERGENCY_CONTACT_MAX)) {
    return {
      ok: false,
      problem: `An emergency contact is 2 to ${EMERGENCY_CONTACT_MAX} characters.`,
    };
  }
  return {
    ok: true,
    fields: {
      guestName: name,
      ...(phone === null ? {} : { guestPhone: phone }),
      ...(emergency === '' ? {} : { guestEmergencyContact: emergency }),
    },
  };
}

/**
 * Everything that stops a walk-in sale, as the one sentence to show — or null.
 * Both counters keep Take payment ENABLED and show this on click, so staff
 * always see why instead of facing a silently disabled button.
 */
export function walkInSaleProblem(input: {
  /** False for a member resolved from a denial: no guest fields to check. */
  guest: boolean;
  name: string;
  email: string;
  phone: string;
  emergencyContact: string;
  waiverAccepted: boolean;
  method: string;
  reference: string;
}): string | null {
  if (input.guest) {
    const checked = validateWalkInGuest(input);
    if (!checked.ok) return checked.problem;
    if (!isPlausibleEmail(input.email)) return "Enter the guest's email — their member link goes there.";
    if (!input.waiverAccepted) return 'The guest must accept the liability waiver first.';
  }
  return saleReferenceProblem(input.method, input.reference);
}
