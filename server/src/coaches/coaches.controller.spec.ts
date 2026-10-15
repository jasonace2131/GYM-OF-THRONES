import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from '../rbac/decorators/require-permission.decorator';
import { AdminCoachingController, CoachProfilesController } from './coaches.controller';
import type { CoachProfilesService } from './coach-profiles.service';
import type { CoachCaseloadService } from './coach-caseload.service';
import type { ProgressService } from '../me/progress.service';
import type { AuthUser } from '../auth/auth.types';

/**
 * The decorators are this controller's access control, and a dropped one
 * fails no behavioural test — so they are pinned here.
 */
describe('coach controllers', () => {
  const key = (target: object, name: string): unknown =>
    Reflect.getMetadata(
      REQUIRE_PERMISSION_KEY,
      (target as Record<string, unknown>)[name] as object,
    );
  const scope = (target: object, name: string): unknown =>
    Reflect.getMetadata(
      REQUIRE_PERMISSION_SCOPE_KEY,
      (target as Record<string, unknown>)[name] as object,
    );

  it('reads profiles on coach.read, at whatever reach the caller holds', () => {
    for (const name of ['list', 'get']) {
      expect(key(CoachProfilesController.prototype, name)).toBe('coach.read');
      expect(scope(CoachProfilesController.prototype, name)).toBeUndefined();
    }
  });

  it('edits a profile on coach.profile.update', () => {
    expect(key(AdminCoachingController.prototype, 'updateProfile')).toBe('coach.profile.update');
  });

  it('opens a caseload on coach.read AT ALL — a coach at OWN is a 403', () => {
    expect(key(AdminCoachingController.prototype, 'caseload')).toBe('coach.read');
    expect(scope(AdminCoachingController.prototype, 'caseload')).toBe('ALL');
  });

  /**
   * Only DEV holds progress.read at ALL (through its bypass). ADMIN holds no
   * progress key and COACH holds it at OWN, so both get 403 here.
   */
  it("opens a member's progress on progress.read AT ALL", () => {
    expect(key(AdminCoachingController.prototype, 'memberProgress')).toBe('progress.read');
    expect(scope(AdminCoachingController.prototype, 'memberProgress')).toBe('ALL');
  });

  it('turns an absent bio into null, so "no bio" clears it', async () => {
    const profiles = { update: jest.fn().mockResolvedValue('ok') };
    const controller = new AdminCoachingController(
      profiles as unknown as CoachProfilesService,
      {} as CoachCaseloadService,
      {} as ProgressService,
    );
    const admin = { id: 'a1', role: 'ADMIN' } as AuthUser;

    await controller.updateProfile('c1', { specializations: ['Strength'] }, admin);

    expect(profiles.update).toHaveBeenCalledWith(admin, 'c1', {
      specializations: ['Strength'],
      bio: null,
    });
  });
});
