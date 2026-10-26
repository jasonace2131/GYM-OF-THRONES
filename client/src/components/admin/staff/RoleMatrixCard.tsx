'use client';

import { useCallback } from 'react';
import { Badge, Card } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { staffApi } from '@/lib/staffApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { MATRIX_ROLES, buildRoleMatrix, cellLabel, matrixRoleLabel } from '@/lib/staff/roleMatrix';

/**
 * "What each role can do" — read-only.
 *
 * Built only from the two endpoints that are the truth: the catalogue and the
 * SEEDED grants (`permission.read`). Collapsed by default: it is reference,
 * not the job, and sixty rows would push the staff list off the screen.
 */
export function RoleMatrixCard() {
  const matrix = useAdminQuery(
    useCallback(async () => {
      const [catalogue, grants] = await Promise.all([
        staffApi.permissionCatalogue(),
        staffApi.roleGrants(),
      ]);
      return buildRoleMatrix(catalogue, grants);
    }, []),
    'staff-role-matrix',
  );

  return (
    <Card padded={false}>
      <details>
        <summary style={{ cursor: 'pointer', padding: 18, listStyle: 'revert' }}>
          <span className="p-card-title">What each role can do</span>
          <span className="p-muted" style={{ marginLeft: 10, fontSize: 13 }}>
            Read-only · from the live permission table
          </span>
        </summary>
        <div style={{ padding: '0 18px 18px' }}>
          <p className="a-field-hint" style={{ marginTop: 0 }}>
            <strong>All</strong> reaches everybody&apos;s records; <strong>Own</strong> reaches the
            person&apos;s own — or, for a coach, the members assigned to them. The Super Admin holds
            every permission.
          </p>
          <DataState
            loading={matrix.loading}
            error={matrix.error}
            empty={(matrix.data?.length ?? 0) === 0}
            emptyTitle="No permissions found"
            onRetry={matrix.reload}
          >
            <div className="a-scroll">
              <table className="p-table" data-stack>
                <thead>
                  <tr>
                    <th>Permission</th>
                    {MATRIX_ROLES.map((role) => (
                      <th key={role} style={{ textAlign: 'center' }}>
                        {matrixRoleLabel(role)}
                      </th>
                    ))}
                  </tr>
                </thead>
                {matrix.data?.map((group) => (
                  <tbody key={group.resource}>
                    <tr>
                      <td
                        colSpan={MATRIX_ROLES.length + 1}
                        style={{
                          fontSize: 11,
                          letterSpacing: '0.12em',
                          textTransform: 'uppercase',
                          color: 'var(--p-ink3)',
                          background: 'var(--p-paper2)',
                        }}
                      >
                        {group.resource}
                      </td>
                    </tr>
                    {group.rows.map((row) => (
                      <tr key={row.key}>
                        <td data-card="title">
                          {row.description}{' '}
                          {row.isDangerous ? <Badge tone="warn">Sensitive</Badge> : null}
                          <div className="a-person-sub">{row.key}</div>
                        </td>
                        {MATRIX_ROLES.map((role) => (
                          <td
                            key={role}
                            data-label={matrixRoleLabel(role)}
                            style={{
                              textAlign: 'center',
                              color: row.cells[role] === null ? 'var(--p-ink3)' : 'var(--p-ink)',
                              fontWeight: row.cells[role] === 'ALL' ? 600 : 400,
                            }}
                          >
                            {cellLabel(row.cells[role])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          </DataState>
        </div>
      </details>
    </Card>
  );
}
