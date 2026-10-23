import { collapseSpaces, isPersonName, normalisePhPhone, PH_PHONE_MESSAGE } from '@got/shared';

/**
 * The admin "Edit member" form's decisions, like `detailsPatch` on the
 * member's own account page: only a CHANGED field is checked and sent, so a
 * legacy value the current rules would refuse (a digit in an old name, a
 * landline) never blocks editing something else.
 */
export interface MemberEditForm {
  firstName: string;
  lastName: string;
  phone: string;
  emergencyContact: string;
}

export interface MemberEditOriginal {
  firstName: string;
  lastName: string;
  phone: string | null;
  emergencyContact: string | null;
}

export interface MemberEditPatch {
  firstName?: string;
  lastName?: string;
  phone?: string | null;
  emergencyContact?: string | null;
}

const NAME_PROBLEM = "Use letters, spaces, apostrophes ('), hyphens (-) and dots in a name.";

export function memberEditPatch(
  original: MemberEditOriginal,
  form: MemberEditForm,
): { patch: MemberEditPatch; problem: string | null } {
  const patch: MemberEditPatch = {};

  const first = collapseSpaces(form.firstName);
  if (first !== original.firstName) {
    if (!isPersonName(first)) return { patch: {}, problem: NAME_PROBLEM };
    patch.firstName = first;
  }
  const last = collapseSpaces(form.lastName);
  if (last !== original.lastName) {
    if (!isPersonName(last)) return { patch: {}, problem: NAME_PROBLEM };
    patch.lastName = last;
  }

  const phone = form.phone.trim();
  if (phone !== (original.phone ?? '')) {
    if (phone === '') patch.phone = null;
    else {
      const stored = normalisePhPhone(phone);
      if (stored === null) return { patch: {}, problem: `${PH_PHONE_MESSAGE}.` };
      patch.phone = stored;
    }
  }

  const emergency = form.emergencyContact.trim();
  if (emergency !== (original.emergencyContact ?? '').trim()) {
    // `null` clears a previously-set contact.
    patch.emergencyContact = emergency === '' ? null : emergency;
  }

  return { patch, problem: null };
}
