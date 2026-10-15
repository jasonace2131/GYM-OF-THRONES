'use client';

import { useCallback, useState } from 'react';
import { PERMISSIONS, roleLabel, type IssuedStaffInvitation, type RoleName } from '@got/shared';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Person } from '@/components/admin/ui';
import { MemberDrawer } from '@/components/admin/MemberDrawer';
import { Can } from '@/components/rbac/guards';
import { useMe } from '@/components/rbac/MeProvider';
import { InviteStaffModal } from '@/components/admin/staff/InviteStaffModal';
import { IssuedLinkCard } from '@/components/admin/staff/IssuedLinkCard';
import { InvitationsCard } from '@/components/admin/staff/InvitationsCard';
import { RoleMatrixCard } from '@/components/admin/staff/RoleMatrixCard';
import { civilDate, type MemberListItem } from '@/lib/adminApi';
import { staffApi } from '@/lib/staffApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { countActiveAdmins } from '@/lib/staff/staffRules';

/** The staff roles, in rank order, for the filter. "All staff" is everyone but members. */
const ROLE_FILTERS: Array<{ value: RoleName | 'ALL'; label: string }> = [
  { value: 'ALL', label: 'All staff' },
  { value: 'FRONT_DESK', label: roleLabel('FRONT_DESK') },
  { value: 'COACH', label: roleLabel('COACH') },
  { value: 'ADMIN', label: roleLabel('ADMIN') },
  { value: 'DEV', label: roleLabel('DEV') },
];

const ROLE_TONE: Partial<Record<string, 'info' | 'warn' | 'neutral'>> = {
  ADMIN: 'warn',
  DEV: 'warn',
  COACH: 'info',
};

/**
 * Staff & Access — who works here, inviting more, and what each role can do.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * EVERY RULE ON THIS SCREEN IS THE SERVER'S RULE, ASKED IN ADVANCE.
 *
 * Which roles the invite form offers, which rows show "Change role" or
 * "Suspend", and which of those are disabled with a reason all come from
 * `@got/shared`'s role hierarchy — the same functions the API enforces. An
 * ADMIN manages front desk and coaches; only the Super Admin manages admins;
 * nobody changes their own account; the last active admin stays.
 *
 * Change role and Suspend are the member drawer's own actions (the brief:
 * reuse, don't rebuild) — opened from a row here, with the admin count this
 * screen knows so "last admin" is explained rather than refused.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function StaffAccessPage() {
  const { me } = useMe();
  const [filter, setFilter] = useState<RoleName | 'ALL'>('ALL');
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<IssuedStaffInvitation | null>(null);
  const [selected, setSelected] = useState<MemberListItem | null>(null);

  // ALWAYS the whole staff list, filtered here: the last-admin count must
  // see every admin whatever the filter shows, and a gym's staff fits in one
  // page. `staff=true` is role ≠ CLIENT on the server.
  const staff = useAdminQuery(
    useCallback(() => staffApi.staff(), []),
    'staff-list',
  );
  const invitations = useAdminQuery(
    useCallback(() => staffApi.invitations(), []),
    'staff-invitations',
  );

  const everyone = staff.data?.items ?? [];
  const shown = filter === 'ALL' ? everyone : everyone.filter((row) => row.role === filter);
  const activeAdmins = countActiveAdmins(
    everyone.map((row) => ({
      id: row.userId,
      role: row.role,
      status: row.status,
      deletedAt: row.deletedAt,
    })),
  );

  const onIssued = (next: IssuedStaffInvitation): void => {
    setIssued(next);
    setInviting(false);
    invitations.reload();
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Card>
        <CardHead
          title="Staff & Access"
          action={
            <button
              type="button"
              className="p-btn p-btn-gold p-btn-sm"
              onClick={() => setInviting(true)}
            >
              Invite staff
            </button>
          }
        />
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
          {me?.role === 'DEV'
            ? 'As Super Admin you can invite and manage admins, as well as front desk and coaches.'
            : 'You can invite front desk and coaches, and change their roles. Only the Super Admin manages admins.'}{' '}
          New members still join from <strong>Members → New member</strong>.
        </p>
      </Card>

      {issued === null ? null : (
        <IssuedLinkCard issued={issued} onDismiss={() => setIssued(null)} />
      )}

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="Staff"
            action={
              <select
                className="a-select"
                aria-label="Filter by role"
                value={filter}
                onChange={(event) => setFilter(event.target.value as RoleName | 'ALL')}
              >
                {ROLE_FILTERS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            }
          />
        </div>
        <DataState
          loading={staff.loading}
          error={staff.error}
          empty={shown.length === 0}
          emptyTitle={
            filter === 'ALL' ? 'No staff yet' : `No ${roleLabel(filter).toLowerCase()} accounts`
          }
          emptyHint="Invite someone with the button above."
          onRetry={staff.reload}
        >
          <div className="a-scroll">
            <table className="p-table" data-clickable>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Account</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <tr
                    key={row.userId}
                    tabIndex={0}
                    onClick={() => setSelected(row)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setSelected(row);
                      }
                    }}
                  >
                    <td>
                      <Person
                        firstName={row.firstName}
                        lastName={row.lastName}
                        sub={row.userId === me?.id ? `${row.email} · you` : row.email}
                        avatarUrl={row.avatarUrl}
                      />
                    </td>
                    <td>
                      <Badge tone={ROLE_TONE[row.role] ?? 'neutral'}>{roleLabel(row.role)}</Badge>
                    </td>
                    <td>
                      <Badge tone={row.status === 'ACTIVE' ? 'ok' : 'danger'}>
                        {row.status === 'ACTIVE'
                          ? 'Active'
                          : row.status === 'SUSPENDED'
                            ? 'Suspended'
                            : 'Closed'}
                      </Badge>
                    </td>
                    <td className="p-muted">{civilDate(row.joinedOn)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
        <p className="a-field-hint" style={{ margin: 0, padding: '10px 18px 16px' }}>
          Open someone to change their role or suspend them.{' '}
          {activeAdmins === 1
            ? 'There is one active admin, so that account cannot be demoted, suspended or deleted.'
            : null}
        </p>
      </Card>

      <DataState
        loading={invitations.loading}
        error={invitations.error}
        empty={false}
        emptyTitle=""
        onRetry={invitations.reload}
      >
        <InvitationsCard
          invitations={invitations.data ?? []}
          callerRole={me?.role ?? null}
          onChanged={invitations.reload}
          onIssued={(next) => {
            setIssued(next);
            invitations.reload();
          }}
        />
      </DataState>

      <Can permission={PERMISSIONS.PERMISSION_READ} scope="ALL">
        <RoleMatrixCard />
      </Can>

      <InviteStaffModal open={inviting} onClose={() => setInviting(false)} onIssued={onIssued} />

      {selected === null ? null : (
        <MemberDrawer
          key={selected.userId}
          member={selected}
          activeAdmins={activeAdmins}
          onClose={() => setSelected(null)}
          reloadList={staff.reload}
        />
      )}
    </div>
  );
}
