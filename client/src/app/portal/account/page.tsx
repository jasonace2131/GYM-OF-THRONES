'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MyProfile } from '@got/shared';
import { changeEmail, changePassword, getProfile, saveProfile } from '@/lib/account';
import { updateEmail, updatePassword, verifyCurrentPassword } from '@/lib/accountAuth';
import { ApiError } from '@/lib/api';
import { Card, EmptyState, Skeleton } from '@/components/portal/ui';
import {
  BodySection,
  EmailSection,
  PasswordSection,
} from '@/components/portal/account/AccountSections';

/**
 * My account — the member's own email, password, body numbers and medical
 * notes. Body numbers and notes are ours (`/me/profile`); email and password
 * are Supabase's, changed from the browser on the member's own session.
 *
 * Ungated: every signed-in person has an account to look after. The route
 * behind it is keyless and hard-coded to the caller.
 */
export default function AccountPage() {
  const [profile, setProfile] = useState<MyProfile | null>(null);
  /**
   * Why the load failed. Only a request that never got an answer is the
   * connection's fault; an HTTP error (404, 5xx) is ours, and telling the
   * member to check their wifi would send them chasing the wrong thing.
   */
  const [failed, setFailed] = useState<'network' | 'http' | null>(null);

  const load = useCallback(() => {
    setFailed(null);
    getProfile()
      .then(setProfile)
      .catch((error: unknown) => setFailed(error instanceof ApiError ? 'http' : 'network'));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (failed !== null) {
    return (
      <Card>
        <EmptyState
          title="Couldn't load your account."
          hint={
            failed === 'network' ? 'Check your connection and try again.' : 'Try again in a moment.'
          }
          action={
            <button type="button" className="p-btn p-btn-dark p-btn-sm" onClick={load}>
              Try again
            </button>
          }
        />
      </Card>
    );
  }

  if (profile === null) {
    return (
      <div style={{ display: 'grid', gap: 20 }}>
        <Skeleton height={300} />
        <Skeleton height={180} />
        <Skeleton height={240} />
      </div>
    );
  }

  return (
    <div style={{ display: 'grid', gap: 20, maxWidth: 640, minWidth: 0 }}>
      <BodySection profile={profile} save={saveProfile} onSaved={setProfile} />
      <EmailSection
        email={profile.email}
        change={(next) => changeEmail({ update: updateEmail }, next)}
      />
      <PasswordSection
        email={profile.email}
        change={(input) =>
          changePassword({ verify: verifyCurrentPassword, update: updatePassword }, input)
        }
      />
    </div>
  );
}
