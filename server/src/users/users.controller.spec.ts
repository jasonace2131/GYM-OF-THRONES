import { UsersController } from './users.controller';
import type { AccountDeletionService } from './account-deletion.service';
import { PermissionsService } from '../rbac/permissions.service';
import type { AuthUser } from '../auth/auth.types';
import type { MyProfileService } from './my-profile.service';
import type { MembershipService } from '../membership/membership.service';

const USER: AuthUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  role: 'CLIENT',
  status: 'ACTIVE',
  permissionVersion: 3,
  heightCm: 175,
  weightKg: 72.4,
  deletedAt: null,
};

describe('UsersController', () => {
  const getEffectivePermissions = jest
    .fn()
    .mockResolvedValue([{ key: 'checkin.self', scope: 'OWN' }]);
  const profiles = {
    get: jest.fn().mockResolvedValue({ email: USER.email }),
    update: jest.fn().mockResolvedValue({ email: USER.email }),
  };
  const memberAccessFor = jest.fn().mockResolvedValue('READ_ONLY');
  const deletion = { deleteOwnAccount: jest.fn().mockResolvedValue(undefined) };
  const controller = new UsersController(
    { getEffectivePermissions } as unknown as PermissionsService,
    profiles as unknown as MyProfileService,
    { memberAccessFor } as unknown as MembershipService,
    deletion as unknown as AccountDeletionService,
  );

  it("returns the current user's profile with effective permissions", async () => {
    await expect(controller.me(USER)).resolves.toEqual({
      id: USER.id,
      email: USER.email,
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      role: 'CLIENT',
      status: 'ACTIVE',
      heightCm: 175,
      weightKg: 72.4,
      permissions: [{ key: 'checkin.self', scope: 'OWN' }],
      memberAccess: 'READ_ONLY',
    });
    expect(getEffectivePermissions).toHaveBeenCalledWith(USER);
    // The membership gate's answer for the member-only features, decided by
    // the server so the portal never reads a role.
    expect(memberAccessFor).toHaveBeenCalledWith(USER);
  });

  it('does not leak supabaseId or permissionVersion to the client', async () => {
    // No cast: MeResponse has no index signature, so a Record<string, unknown>
    // cast here was unsound (TS2352) and jest's toHaveProperty accepts any
    // value anyway, so the cast was never load-bearing.
    const body = await controller.me(USER);
    expect(body).not.toHaveProperty('supabaseId');
    expect(body).not.toHaveProperty('permissionVersion');
  });

  it("GET /me/profile reads the caller's own profile, by the token's user id", async () => {
    await controller.profile(USER);
    expect(profiles.get).toHaveBeenCalledWith(USER.id);
  });

  it("PATCH /me/profile updates the caller's own profile, by the token's user id", async () => {
    await controller.updateProfile(USER, { weightKg: 70 });
    expect(profiles.update).toHaveBeenCalledWith(USER.id, { weightKg: 70 });
  });

  it("POST /me/delete-account deletes the caller's own account, with the typed password", async () => {
    await expect(
      controller.deleteAccount(USER, { confirm: true, password: 'secret12' }),
    ).resolves.toEqual({ deleted: true });
    expect(deletion.deleteOwnAccount).toHaveBeenCalledWith(USER, 'secret12');
  });
});
