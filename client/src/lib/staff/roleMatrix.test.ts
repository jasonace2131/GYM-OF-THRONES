import { describe, expect, it } from 'vitest';
import { MATRIX_ROLES, buildRoleMatrix, cellLabel, type RoleGrants } from './roleMatrix';

const catalogue = {
  member: [
    {
      key: 'member.read',
      resource: 'member',
      action: 'read',
      description: 'View member profiles',
      isDangerous: false,
      requires: [],
    },
    {
      key: 'member.delete',
      resource: 'member',
      action: 'delete',
      description: 'Delete a member',
      isDangerous: true,
      requires: ['member.read'],
    },
  ],
  staff: [
    {
      key: 'staff.invite',
      resource: 'staff',
      action: 'invite',
      description: 'Invite staff',
      isDangerous: true,
      requires: [],
    },
  ],
};

const grants: RoleGrants = {
  CLIENT: [],
  FRONT_DESK: [{ key: 'member.read', scope: 'ALL' }],
  COACH: [{ key: 'member.read', scope: 'OWN' }],
  ADMIN: [
    { key: 'member.read', scope: 'ALL' },
    { key: 'member.delete', scope: 'ALL' },
    { key: 'staff.invite', scope: 'ALL' },
  ],
};

describe('buildRoleMatrix', () => {
  it('has a column per role, the Super Admin last', () => {
    expect(MATRIX_ROLES).toEqual(['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN', 'DEV']);
  });

  it('keeps the catalogue grouping and order, one row per key', () => {
    const groups = buildRoleMatrix(catalogue, grants);
    expect(groups.map((g) => g.resource)).toEqual(['member', 'staff']);
    expect(groups[0].rows.map((r) => r.key)).toEqual(['member.read', 'member.delete']);
  });

  it('fills each cell with the scope that role holds, or null', () => {
    const [member] = buildRoleMatrix(catalogue, grants);
    expect(member.rows[0].cells).toEqual({
      CLIENT: null,
      FRONT_DESK: 'ALL',
      COACH: 'OWN',
      ADMIN: 'ALL',
      DEV: 'ALL',
    });
  });

  /** DEV holds no rows — it bypasses the table — so its column is drawn, not read. */
  it('draws the Super Admin with every key at ALL', () => {
    for (const group of buildRoleMatrix(catalogue, grants)) {
      for (const matrixRow of group.rows) expect(matrixRow.cells.DEV).toBe('ALL');
    }
  });

  it('carries the description and the dangerous flag', () => {
    const [member] = buildRoleMatrix(catalogue, grants);
    expect(member.rows[1]).toMatchObject({ description: 'Delete a member', isDangerous: true });
  });
});

describe('cellLabel', () => {
  it('reads All, Own, or a dash', () => {
    expect(cellLabel('ALL')).toBe('All');
    expect(cellLabel('OWN')).toBe('Own');
    expect(cellLabel(null)).toBe('—');
  });
});
