/**
 * After a member deletes their account, My account sets this flag and goes to
 * `/`, where the landing page shows the notice once. No imports on purpose:
 * the landing page must not pull the API or Supabase clients in for one line.
 */
export const ACCOUNT_DELETED_FLAG = 'got.accountDeleted';

export const ACCOUNT_DELETED_NOTICE = 'Your account was deleted.';

/**
 * Whether the flag is set — read, not consumed (the landing page consumes it).
 * The portal shell checks it so its signed-out redirect goes to `/`, not to
 * `/login`, and cannot race My account's own redirect there.
 */
export function accountJustDeleted(): boolean {
  try {
    return window.sessionStorage.getItem(ACCOUNT_DELETED_FLAG) !== null;
  } catch {
    return false;
  }
}
