/**
 * Member-row actions nobody may take on their OWN account from the console:
 * change their role, suspend or reactivate themselves, or delete themselves
 * (owner decision). Editing your own profile stays allowed.
 *
 * This is presentation, not enforcement: the server is the authority. It
 * stops the console offering an admin the one click that locks them out.
 */
export type MemberAction = 'edit' | 'role' | 'suspend' | 'reactivate' | 'delete';

const NEVER_ON_SELF: ReadonlySet<MemberAction> = new Set([
  'role',
  'suspend',
  'reactivate',
  'delete',
]);

/**
 * Whether `action` may be offered on `memberId`'s row to the caller `selfId`.
 * An unknown caller (`/me` not loaded) is refused the self-forbidden actions,
 * so the menu fails closed.
 */
export function allowedOnMember(
  action: MemberAction,
  selfId: string | null | undefined,
  memberId: string,
): boolean {
  if (!NEVER_ON_SELF.has(action)) return true;
  if (selfId === null || selfId === undefined) return false;
  return selfId !== memberId;
}
