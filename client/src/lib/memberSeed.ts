export interface NewMemberSeed {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  emergencyContact?: string;
  /** Marks the enquiry CONVERTED with the new member's id, server-side. */
  leadId?: string;
  /** The guest VISIT this conversion came from — stamps
   *  `CheckIn.convertedToUserId`, which is what makes "converted to members"
   *  countable on the walk-in report. */
  fromCheckInId?: string;
}

/**
 * One string on the visit row, two fields on the account — the same
 * split-on-first-space the desk presenter renders with. Exported here so the
 * attendance page and the walk-ins register share one copy instead of three.
 */
export function seedFromGuest(guest: {
  guestName: string | null;
  guestPhone: string | null;
  guestEmail: string | null;
  guestEmergencyContact: string | null;
}): NewMemberSeed {
  const name = (guest.guestName ?? '').trim();
  const space = name.indexOf(' ');
  return {
    firstName: space === -1 ? name : name.slice(0, space),
    lastName: space === -1 ? '' : name.slice(space + 1),
    email: guest.guestEmail ?? '',
    phone: guest.guestPhone ?? '',
    emergencyContact: guest.guestEmergencyContact ?? '',
  };
}
