'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { PERMISSIONS, type CoachProfileView } from '@got/shared';
import { ApiError } from '@/lib/api';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Person } from '@/components/admin/ui';
import { MemberPicker } from '@/components/admin/MemberPicker';
import { usePermission } from '@/components/rbac/MeProvider';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';
import { CoachProfileModal } from '@/components/admin/coaches/CoachProfileModal';
import { adminApi, civilDate, type MemberListItem } from '@/lib/adminApi';
import { staffApi } from '@/lib/staffApi';
import { coachOptionLabel, specializationsLine } from '@/lib/coaches/profileDraft';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ChatReviewCard } from '@/components/admin/ChatReviewCard';

/**
 * Coaches, and who they coach.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A COACH IS A USER WITH A ROLE. There is no Coach table and there should not
 * be one — it would be a second place to keep a name, a phone number and an
 * account status in sync, and the two copies would disagree the first time
 * somebody edited one of them.
 *
 * So this screen is the roster endpoint filtered by role, joined against
 * active coach assignments for the caseload count. The one thing a user row
 * has no column for — what a coach specialises in, and a short bio — is the
 * `CoachProfile` table (Staff & Access), written by an admin here and read by
 * members on My Coach. "Sessions" is still NOT invented: a card showing "42
 * sessions" that is really "42 assigned members" is the kind of
 * plausible-looking fabrication that costs a screen its credibility the first
 * time somebody checks it.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * THE ASSIGNMENT PANEL BELOW IS NEW, and closes REQ014. Until it existed this
 * page ended with a paragraph admitting that assignment "runs through the
 * coach-assignment API today; a screen for it is the next thing this page
 * needs" — so reassigning a member meant a hand-written HTTP request. The API
 * had been complete the whole time.
 */

const ASSIGNMENT_LIMIT = 200;

export default function AdminCoachesPage() {
  const canAssign = usePermission(PERMISSIONS.COACH_ASSIGN);
  const canEnd = usePermission(PERMISSIONS.COACH_UPDATE);
  const canEditProfile = usePermission(PERMISSIONS.COACH_PROFILE_UPDATE, { scope: 'ALL' });
  const [editing, setEditing] = useState<MemberListItem | null>(null);

  // Every coach's profile in one request, keyed by coach id below.
  const profilesQuery = useAdminQuery(
    useCallback(() => staffApi.coachProfiles(), []),
    'coach-profiles',
  );
  const profiles = new Map<string, CoachProfileView>(
    (profilesQuery.data ?? []).map((profile) => [profile.userId, profile]),
  );

  /** Active-only by default: "who coaches whom right now" is the live question. */
  const [showEnded, setShowEnded] = useState(false);

  const coaches = useAdminQuery(
    useCallback(() => adminApi.members({ role: 'COACH', limit: 50 }), []),
    'coaches',
  );

  const assignments = useAdminQuery(
    useCallback(
      () => adminApi.coachAssignments({ limit: ASSIGNMENT_LIMIT, activeOnly: !showEnded }),
      [showEnded],
    ),
    `coach-assignments:${showEnded ? 'all' : 'active'}`,
  );

  // Counted client-side from the assignment list rather than asked for as a
  // number the server does not expose. One request, no invented field.
  const caseload = new Map<string, number>();
  for (const row of assignments.data?.items ?? []) {
    if (row.status !== 'ACTIVE') continue;
    caseload.set(row.coachId, (caseload.get(row.coachId) ?? 0) + 1);
  }

  const coachOptions = coaches.data?.items ?? [];

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <DataState
        loading={coaches.loading}
        error={coaches.error}
        empty={(coaches.data?.items.length ?? 0) === 0}
        emptyTitle="No coaches yet"
        emptyHint="A coach is an account with the Coach role. Invite one from Staff & Access, or change an existing member's role from their record."
        onRetry={coaches.reload}
      >
        <div
          style={{
            display: 'grid',
            gap: 16,
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
          }}
        >
          {coachOptions.map((coach) => (
            <Card key={coach.userId}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  justifyContent: 'space-between',
                  gap: 12,
                }}
              >
                <Person
                  firstName={coach.firstName}
                  lastName={coach.lastName}
                  sub={coach.email}
                  avatarUrl={coach.avatarUrl}
                />
                <Badge tone={coach.status === 'ACTIVE' ? 'ok' : 'danger'}>
                  {coach.status === 'ACTIVE' ? 'Active' : 'Inactive'}
                </Badge>
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: 20,
                  marginTop: 16,
                  fontSize: 13,
                  color: 'var(--p-ink2)',
                }}
              >
                <span>
                  <strong className="p-num" style={{ fontSize: 18 }}>
                    {caseload.get(coach.userId) ?? 0}
                  </strong>
                  <div className="a-person-sub">members assigned</div>
                </span>
                <span>
                  <strong className="p-num" style={{ fontSize: 18 }}>
                    {coach.checkInCount}
                  </strong>
                  <div className="a-person-sub">own visits</div>
                </span>
                <span>
                  <strong style={{ fontSize: 15 }}>{coach.phone ?? '—'}</strong>
                  <div className="a-person-sub">phone</div>
                </span>
              </div>

              {/* Staff & Access: what members read about this coach. */}
              <CoachProfileSummary profile={profiles.get(coach.userId)} />

              <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                <Link
                  href={`/admin/coaches/${coach.userId}`}
                  className="p-btn p-btn-ghost p-btn-sm"
                >
                  View caseload
                </Link>
                {canEditProfile ? (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setEditing(coach)}
                  >
                    Edit profile
                  </button>
                ) : null}
              </div>
            </Card>
          ))}
        </div>
      </DataState>

      {editing === null ? null : (
        <CoachProfileModal
          key={editing.userId}
          open
          coach={editing}
          profile={profiles.get(editing.userId)}
          onClose={() => setEditing(null)}
          onSaved={() => profilesQuery.reload()}
        />
      )}

      {canAssign ? (
        <AssignForm
          coaches={coachOptions}
          profiles={profiles}
          onAssigned={() => assignments.reload()}
        />
      ) : null}

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="Assignments"
            action={
              <div style={{ display: 'flex', gap: 6 }}>
                {(
                  [
                    [false, 'Active'],
                    [true, 'All'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    className={`p-btn p-btn-sm ${showEnded === value ? 'p-btn-gold' : 'p-btn-ghost'}`}
                    onClick={() => setShowEnded(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          />
        </div>

        <DataState
          loading={assignments.loading}
          error={assignments.error}
          empty={(assignments.data?.items.length ?? 0) === 0}
          emptyTitle={showEnded ? 'No assignments on record' : 'Nobody is assigned a coach'}
          emptyHint="Assign one above. A member has at most one active coach at a time."
          onRetry={assignments.reload}
        >
          <div className="a-scroll">
            <table className="p-table">
              <thead>
                <tr>
                  <th>Member</th>
                  <th>Coach</th>
                  <th>Since</th>
                  <th>Standing</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {assignments.data?.items.map((row) => (
                  <AssignmentRow
                    key={row.id}
                    row={row}
                    canEnd={canEnd && row.status === 'ACTIVE'}
                    onEnded={() => assignments.reload()}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </Card>

      <Card>
        <CardHead title="How assignment works" />
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
          A member has <strong>at most one active coach</strong> — enforced in the database by a
          unique sentinel, not by a check in application code, so two staff assigning at once cannot
          both win. Assigning a member who already has a coach is a{' '}
          <strong>reassignment</strong>: the old assignment is ended and the new one starts, in one
          transaction. Ending an assignment keeps the row, so past coaching is still answerable.
        </p>
      </Card>

      {/* feat/coach-tools: complaint review of coach chat, chat.review only. */}
      <ChatReviewCard />
    </div>
  );
}

/**
 * A coach's profile on their card. "No profile yet" is said, not hidden: an
 * admin looking at a blank card should know there is something to fill in.
 */
function CoachProfileSummary({ profile }: { profile: CoachProfileView | undefined }) {
  const line = specializationsLine(profile?.specializations);
  if (profile === undefined || (line === '' && profile.bio === null)) {
    return (
      <p className="p-muted" style={{ margin: '14px 0 0', fontSize: 13 }}>
        No profile yet — members see just the name.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
      {line === '' ? null : <div style={{ fontSize: 13, fontWeight: 600 }}>{line}</div>}
      {profile.bio === null ? null : (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--p-ink2)' }}>
          {profile.bio}
        </p>
      )}
    </div>
  );
}

function AssignmentRow({
  row,
  canEnd,
  onEnded,
}: {
  row: {
    id: string;
    coachName: string;
    memberName: string;
    memberCode: string | null;
    status: string;
    startedAt: string;
    endedAt: string | null;
  };
  canEnd: boolean;
  onEnded: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const { busy, error, run, reset } = useConfirmAction();

  const end = (): void => {
    void run(() => adminApi.endCoachAssignment(row.id)).then((ok) => {
      if (!ok) return;
      reset();
      setConfirming(false);
      onEnded();
    });
  };

  return (
    <tr>
      <td>
        <strong>{row.memberName}</strong>
        <div className="a-person-sub">{row.memberCode ?? '—'}</div>
      </td>
      <td>{row.coachName}</td>
      <td className="p-muted">{civilDate(row.startedAt.slice(0, 10))}</td>
      <td>
        {row.status === 'ACTIVE' ? (
          <Badge tone="ok">Active</Badge>
        ) : (
          <Badge tone="neutral">
            Ended {row.endedAt === null ? '' : civilDate(row.endedAt.slice(0, 10))}
          </Badge>
        )}
      </td>
      <td style={{ textAlign: 'right' }}>
        {!canEnd ? null : (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            End
          </button>
        )}

        <ConfirmDialog
          open={confirming}
          title={`End ${row.coachName}'s coaching of ${row.memberName}?`}
          consequence={`${row.memberName} no longer has an active coach. The assignment is kept, so past coaching stays on record.`}
          confirmLabel="End assignment"
          cancelLabel="Keep coaching"
          tone="danger"
          busy={busy}
          error={error}
          onConfirm={end}
          onClose={() => {
            if (busy) return;
            reset();
            setConfirming(false);
          }}
        />
      </td>
    </tr>
  );
}

/**
 * Assign, or reassign — one form, because the server treats them as one call.
 *
 * A separate "reassign" flow would have to ask staff whether the member
 * already has a coach, which is a question the database can answer and a
 * person should not be asked.
 */
function AssignForm({
  coaches,
  profiles,
  onAssigned,
}: {
  coaches: MemberListItem[];
  /** Staff & Access: each coach's specializations ride along in the picker. */
  profiles: ReadonlyMap<string, CoachProfileView>;
  onAssigned: () => void;
}) {
  const [member, setMember] = useState<MemberListItem | null>(null);
  const [coachId, setCoachId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const coach = coaches.find((candidate) => candidate.userId === coachId) ?? null;

  const submit = async (): Promise<void> => {
    if (member === null || coachId === '') return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const trimmed = notes.trim();
      await adminApi.assignCoach({
        coachId,
        memberId: member.userId,
        ...(trimmed === '' ? {} : { notes: trimmed }),
      });
      setDone(`${member.firstName} ${member.lastName} assigned.`);
      setConfirming(false);
      setMember(null);
      setNotes('');
      onAssigned();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ borderColor: 'var(--gold)' }}>
      <CardHead title="Assign a coach" />

      <form
        className="a-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          if (member === null || coachId === '') return;
          setError(null);
          setDone(null);
          setConfirming(true);
        }}
      >
        <MemberPicker value={member} onSelect={setMember} label="Member" />

        <label>
          <span className="a-person-sub">COACH</span>
          <select
            className="a-input"
            value={coachId}
            required
            onChange={(event) => setCoachId(event.target.value)}
          >
            <option value="">Choose a coach…</option>
            {coaches.map((coach) => (
              <option key={coach.userId} value={coach.userId}>
                {coachOptionLabel(coach, profiles.get(coach.userId)?.specializations)}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span className="a-person-sub">NOTE (OPTIONAL)</span>
          <input
            className="a-input"
            value={notes}
            maxLength={200}
            placeholder="Why this pairing — read by staff, not the member"
            onChange={(event) => setNotes(event.target.value)}
          />
        </label>

        {error === null ? null : (
          <p style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>{error}</p>
        )}
        {done === null ? null : (
          <p style={{ color: 'var(--p-ink2)', fontSize: 14, margin: 0 }}>{done}</p>
        )}

        <button
          type="submit"
          className="p-btn p-btn-gold"
          disabled={busy || member === null || coachId === ''}
        >
          {busy ? 'Assigning…' : 'Assign'}
        </button>
      </form>

      <ConfirmDialog
        open={confirming && member !== null}
        title={`Assign ${coach === null ? 'this coach' : `${coach.firstName} ${coach.lastName}`} to ${member === null ? '' : `${member.firstName} ${member.lastName}`}?`}
        consequence="If they already have a coach, that assignment ends and this one starts, in one step. The coach sees them in their client list."
        confirmLabel="Assign coach"
        cancelLabel="Back"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </Card>
  );
}
