'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PERMISSIONS, roleLabel } from '@got/shared';
import { Badge, Card, CardHead, EmptyState, Stat } from '@/components/portal/ui';
import { DataState, Person } from '@/components/admin/ui';
import { Can } from '@/components/rbac/guards';
import { usePermission } from '@/components/rbac/MeProvider';
import { WeightChart } from '@/components/portal/progress/WeightChart';
import { MeasurementHistory } from '@/components/portal/progress/MeasurementHistory';
import { GoalRow } from '@/components/portal/progress/GoalRow';
import { civilDate } from '@/lib/adminApi';
import { staffApi } from '@/lib/staffApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { specializationsLine } from '@/lib/coaches/profileDraft';
import { formatBmi, formatChangeKg, formatKg } from '@/lib/progress/progressView';
import type { CoachMemberRow } from '@/lib/coachApi';

/**
 * One coach's caseload, READ-ONLY — and, for the Super Admin, each client's
 * progress, read-only too.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO AUDIENCES ON ONE PAGE, SPLIT BY PERMISSION, NOT BY ROLE.
 *
 * The caseload is `coach.read` at ALL: every admin. A client's progress is
 * `progress.read` at ALL, which no role is granted — coaches hold it at OWN
 * for their own members, and admins keep the owner's "no progress" rule — so
 * only the Super Admin reaches it, through the DEV bypass. The progress panel
 * sits inside `<Can permission="progress.read" scope="ALL">`: an admin never
 * sees it, and never fires a request that would 403.
 *
 * Nothing here writes. Recording progress stays the assigned coach's job.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function CoachCaseloadPage() {
  const params = useParams<{ coachId: string }>();
  const coachId = params.coachId;
  const canSeeProgress = usePermission(PERMISSIONS.PROGRESS_READ, { scope: 'ALL' });
  const [selected, setSelected] = useState<CoachMemberRow | null>(null);

  const caseload = useAdminQuery(
    useCallback(() => staffApi.coachCaseload(coachId), [coachId]),
    `coach-caseload:${coachId}`,
  );
  const data = caseload.data;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Link
        href="/admin/coaches"
        style={{
          fontSize: 13,
          color: 'var(--p-ink3)',
          textDecoration: 'none',
          width: 'fit-content',
        }}
      >
        ← Coaches
      </Link>

      <DataState
        loading={caseload.loading}
        error={caseload.error}
        empty={data === null}
        emptyTitle="Coach not found"
        onRetry={caseload.reload}
      >
        {data === null ? null : (
          <>
            <Card>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                <Person
                  firstName={data.coach.firstName}
                  lastName={data.coach.lastName}
                  sub={`${data.members.length} ${data.members.length === 1 ? 'client' : 'clients'} assigned`}
                  avatarUrl={data.coach.avatarUrl}
                />
                <Badge tone="info">{roleLabel(data.coach.role)}</Badge>
              </div>
              {data.profile === null ? null : (
                <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
                  {data.profile.specializations.length === 0 ? null : (
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {specializationsLine(data.profile.specializations)}
                    </div>
                  )}
                  {data.profile.bio === null ? null : (
                    <p
                      style={{ margin: 0, fontSize: 13, lineHeight: 1.55, color: 'var(--p-ink2)' }}
                    >
                      {data.profile.bio}
                    </p>
                  )}
                </div>
              )}
              <p className="a-field-hint" style={{ margin: '12px 0 0' }}>
                Read-only. Coaches record their clients&apos; progress from their own dashboard.
              </p>
            </Card>

            <Card padded={false}>
              <div style={{ padding: '18px 18px 0' }}>
                <CardHead title="Caseload" />
              </div>
              {data.members.length === 0 ? (
                <EmptyState
                  title="Nobody is assigned to this coach"
                  hint="Assign members from the Coaches screen."
                />
              ) : (
                <div className="a-scroll">
                  <table className="p-table" data-clickable={canSeeProgress || undefined}>
                    <thead>
                      <tr>
                        <th>Client</th>
                        <th>Since</th>
                        <th>Last visit</th>
                        <th>Visits (30 days)</th>
                        <th>Class attendance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((row) => (
                        <tr
                          key={row.userId}
                          aria-selected={selected?.userId === row.userId || undefined}
                          tabIndex={canSeeProgress ? 0 : undefined}
                          onClick={canSeeProgress ? () => setSelected(row) : undefined}
                          onKeyDown={
                            canSeeProgress
                              ? (event) => {
                                  if (event.key === 'Enter' || event.key === ' ') {
                                    event.preventDefault();
                                    setSelected(row);
                                  }
                                }
                              : undefined
                          }
                        >
                          <td>
                            <Person
                              firstName={row.firstName}
                              lastName={row.lastName}
                              sub={row.memberCode ?? 'No member code yet'}
                              avatarUrl={row.avatarUrl}
                            />
                          </td>
                          <td className="p-muted">{civilDate(row.since.slice(0, 10))}</td>
                          <td>
                            {row.inGymNow ? (
                              <Badge tone="ok">In the gym</Badge>
                            ) : row.lastVisitAt === null ? (
                              <span className="p-muted">Never</span>
                            ) : (
                              civilDate(row.lastVisitAt.slice(0, 10))
                            )}
                          </td>
                          <td className="p-num">{row.visits30d}</td>
                          <td>
                            {row.attendanceRate === null
                              ? '—'
                              : `${row.attendanceRate}% of ${row.classesMarked}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Can permission={PERMISSIONS.PROGRESS_READ} scope="ALL">
                <p className="a-field-hint" style={{ margin: 0, padding: '10px 18px 16px' }}>
                  Open a client to see their progress, read-only.
                </p>
              </Can>
            </Card>

            <Can permission={PERMISSIONS.PROGRESS_READ} scope="ALL">
              {selected === null ? null : (
                <MemberProgressPanel key={selected.userId} member={selected} />
              )}
            </Can>
          </>
        )}
      </DataState>
    </div>
  );
}

/**
 * One client's progress, exactly as their coach's drill-down reads it — the
 * same endpoint shape and the same components, with every control switched
 * off: no record form, no row actions, goals neither editable nor removable.
 */
function MemberProgressPanel({ member }: { member: CoachMemberRow }) {
  const progress = useAdminQuery(
    useCallback(() => staffApi.memberProgress(member.userId), [member.userId]),
    `admin-member-progress:${member.userId}`,
  );
  const data = progress.data;
  const weighed = data?.measurements.filter((m) => m.weightGrams !== null) ?? [];

  return (
    <DataState
      loading={progress.loading}
      error={progress.error}
      empty={data === null}
      emptyTitle="No progress to show"
      onRetry={progress.reload}
    >
      {data === null ? null : (
        <div style={{ display: 'grid', gap: 18 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <h2 className="p-h2" style={{ margin: 0 }}>
              {member.firstName} {member.lastName} — progress
            </h2>
            <Badge tone="neutral">Read-only</Badge>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 14,
            }}
          >
            <Stat
              value={
                data.latestWeightGrams === null ? '—' : `${formatKg(data.latestWeightGrams)}kg`
              }
              label="Current weight"
            />
            <Stat
              value={data.changeGrams === null ? '—' : `${formatChangeKg(data.changeGrams)}kg`}
              label={data.changeOverDays === null ? 'Change' : `Over ${data.changeOverDays} days`}
              accent
            />
            <Stat
              value={data.bmiThousandths === null ? '—' : formatBmi(data.bmiThousandths)}
              label="BMI"
            />
            <Stat
              value={data.goals.filter((g) => g.achievedAt === null).length}
              label="Active goals"
            />
          </div>

          <Card>
            <CardHead title="Weight" />
            {weighed.length < 2 ? (
              <p className="p-muted" style={{ margin: 0, fontSize: 13.5 }}>
                {weighed.length === 0 ? 'No weigh-ins yet.' : 'One weigh-in so far.'}
              </p>
            ) : (
              <WeightChart points={weighed} />
            )}
          </Card>

          <Card>
            <CardHead title="History" />
            {data.measurements.length === 0 ? (
              <p className="p-muted" style={{ margin: 0, fontSize: 13.5 }}>
                Nothing recorded yet.
              </p>
            ) : (
              <MeasurementHistory entries={data.measurements} />
            )}
          </Card>

          <Card>
            <CardHead title="Goals" />
            {data.goals.length === 0 ? (
              <p className="p-muted" style={{ margin: 0, fontSize: 13.5 }}>
                No goals yet.
              </p>
            ) : (
              <div style={{ display: 'grid', gap: 18 }}>
                {data.goals.map((goal) => (
                  <GoalRow key={goal.id} goal={goal} />
                ))}
              </div>
            )}
          </Card>
        </div>
      )}
    </DataState>
  );
}
