'use client';

import { useEffect, useState } from 'react';
import type { CoachProfileView } from '@got/shared';
import { Badge, Card, CardHead, Skeleton } from '@/components/portal/ui';
import { useMe } from '@/components/rbac/MeProvider';
import { coachApi } from '@/lib/coachApi';

/**
 * Staff & Access: the coach's own profile — what their members read on My
 * Coach — shown READ-ONLY on the Coach Dashboard.
 *
 * Read-only because writing it is `coach.profile.update`, an admin's key: a
 * coach describing themselves to the members they are assigned is exactly
 * the copy a manager wants to see before it goes out. The card says so, and
 * says who to ask.
 *
 * A failure to load renders nothing rather than an error card: this is the
 * least important panel on a working dashboard, and a coach mid-shift does
 * not need to be told it is missing.
 */
export function OwnCoachProfileCard() {
  const { me } = useMe();
  const coachId = me?.id ?? null;
  const [profile, setProfile] = useState<CoachProfileView | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'failed'>('loading');

  useEffect(() => {
    if (coachId === null) return;
    let cancelled = false;
    coachApi.ownProfile(coachId).then(
      (found) => {
        if (cancelled) return;
        setProfile(found);
        setState('ok');
      },
      () => {
        if (!cancelled) setState('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [coachId]);

  if (state === 'failed') return null;

  const empty = profile !== null && profile.specializations.length === 0 && profile.bio === null;

  return (
    <Card>
      <CardHead
        title="My coach profile"
        action={
          <span className="p-muted" style={{ fontSize: 12.5 }}>
            What your members see
          </span>
        }
      />
      {state === 'loading' || profile === null ? (
        <Skeleton height={60} />
      ) : empty ? (
        <p className="p-muted" style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>
          No profile yet — your members see just your name. An admin writes it from the console; ask
          them to add your specializations and a short bio.
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {profile.specializations.length === 0 ? null : (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {profile.specializations.map((tag) => (
                <Badge key={tag} tone="info">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
          {profile.bio === null ? null : (
            <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
              {profile.bio}
            </p>
          )}
          <p className="p-muted" style={{ margin: 0, fontSize: 12 }}>
            Something to change? Ask an admin they edit it from the console.
          </p>
        </div>
      )}
    </Card>
  );
}
