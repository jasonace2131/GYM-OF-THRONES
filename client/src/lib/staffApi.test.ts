import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import { inviteApi, staffApi } from './staffApi';

/**
 * Thin-wrapper contract tests, the same shape as `coachApi.test.ts`: each
 * asserts the path, method and body handed to `apiFetch`, and nothing else.
 */
describe('staffApi', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('staff() lists everybody who is not a member, optionally one role', async () => {
    await staffApi.staff();
    expect(apiFetch).toHaveBeenCalledWith('/members?staff=true&limit=100');
    await staffApi.staff('COACH');
    expect(apiFetch).toHaveBeenLastCalledWith('/members?staff=true&limit=100&role=COACH');
  });

  it('invite() posts the address and the role — nothing else', async () => {
    await staffApi.invite({ email: 'ana@example.com', role: 'COACH' });
    expect(apiFetch).toHaveBeenCalledWith('/staff-invitations', {
      method: 'POST',
      body: JSON.stringify({ email: 'ana@example.com', role: 'COACH' }),
    });
  });

  it('resend() and revoke() post to the invitation, encoded', async () => {
    await staffApi.resendInvitation('i/1');
    expect(apiFetch).toHaveBeenCalledWith('/staff-invitations/i%2F1/resend', {
      method: 'POST',
      body: '{}',
    });
    await staffApi.revokeInvitation('i1');
    expect(apiFetch).toHaveBeenLastCalledWith('/staff-invitations/i1/revoke', {
      method: 'POST',
      body: '{}',
    });
  });

  it('reads the catalogue and the seeded grants for the matrix', async () => {
    await staffApi.permissionCatalogue();
    expect(apiFetch).toHaveBeenCalledWith('/admin/permissions');
    await staffApi.roleGrants();
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/permissions/roles');
  });

  it('coach profiles: list, one, and the admin edit', async () => {
    await staffApi.coachProfiles();
    expect(apiFetch).toHaveBeenCalledWith('/coaches/profiles');
    await staffApi.coachProfile('c1');
    expect(apiFetch).toHaveBeenLastCalledWith('/coaches/c1/profile');
    await staffApi.updateCoachProfile('c1', { specializations: ['Strength'], bio: null });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/coaches/c1/profile', {
      method: 'PUT',
      body: JSON.stringify({ specializations: ['Strength'], bio: null }),
    });
  });

  it('the Super Admin coaching view: a caseload and a member progress', async () => {
    await staffApi.coachCaseload('c1');
    expect(apiFetch).toHaveBeenCalledWith('/admin/coaches/c1/caseload');
    await staffApi.memberProgress('m1');
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/members/m1/progress');
  });
});

describe('inviteApi (the public invite page)', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('looks the token up in the query string, encoded', async () => {
    await inviteApi.lookup('abc_DEF-123');
    expect(apiFetch).toHaveBeenCalledWith('/staff-invitations/lookup?token=abc_DEF-123');
  });

  it('claims and accepts with the token in the body — never a role', async () => {
    await inviteApi.claimLink('tok');
    expect(apiFetch).toHaveBeenCalledWith('/staff-invitations/claim-link', {
      method: 'POST',
      body: JSON.stringify({ token: 'tok' }),
    });
    await inviteApi.accept('tok');
    expect(apiFetch).toHaveBeenLastCalledWith('/staff-invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token: 'tok' }),
    });
  });
});
