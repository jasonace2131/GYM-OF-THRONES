import { HttpStatus } from '@nestjs/common';
import { MyProfileService } from './my-profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// 10:00 in Manila on 2026-10-23.
const NOW = new Date('2026-10-23T02:00:00.000Z');

const ROW = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: '+63 917 555 0142',
  memberCode: 'K7Q2MX',
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
  role: 'CLIENT',
  membership: {
    planName: 'Quarterly',
    status: 'ACTIVE',
    endsOn: new Date('2027-01-11T00:00:00.000Z'),
  },
};

/** What the page receives for ROW: no role, a summary instead of the raw membership. */
const PROFILE = {
  email: 'juan@example.com',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  phone: '+63 917 555 0142',
  memberCode: 'K7Q2MX',
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
  membership: { planName: 'Quarterly', status: 'ACTIVE', endsOn: '2027-01-11', daysLeft: 80 },
  canDeleteAccount: true,
};

const PROFILE_SELECT = {
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  memberCode: true,
  heightCm: true,
  weightKg: true,
  medicalNotes: true,
  shareMedicalWithPlanner: true,
  role: true,
  membership: { select: { planName: true, status: true, endsOn: true } },
};

function build() {
  const user = {
    findFirst: jest.fn().mockResolvedValue(ROW),
    update: jest.fn().mockImplementation(({ data }: { data: object }) => ({ ...ROW, ...data })),
  };
  const gym = { timeZone: 'Asia/Manila' } as GymConfigService;
  const service = new MyProfileService({ user } as unknown as PrismaService, gym);
  return { service, user };
}

describe('MyProfileService', () => {
  describe('get', () => {
    it("reads the caller's own row, live and not soft-deleted", async () => {
      const { service, user } = build();
      await expect(service.get(USER_ID, NOW)).resolves.toEqual(PROFILE);
      expect(user.findFirst).toHaveBeenCalledWith({
        where: { id: USER_ID, deletedAt: null },
        select: PROFILE_SELECT,
      });
    });

    it('never sends the role', async () => {
      const { service } = build();
      expect(await service.get(USER_ID, NOW)).not.toHaveProperty('role');
    });

    it('says null for no plan on file', async () => {
      const { service, user } = build();
      user.findFirst.mockResolvedValue({ ...ROW, membership: null });
      expect((await service.get(USER_ID, NOW)).membership).toBeNull();
    });

    it('never counts below zero days left on an ended term', async () => {
      const { service, user } = build();
      user.findFirst.mockResolvedValue({
        ...ROW,
        membership: { ...ROW.membership, status: 'EXPIRED', endsOn: new Date('2026-10-01') },
      });
      expect((await service.get(USER_ID, NOW)).membership?.daysLeft).toBe(0);
    });

    it('opens account deletion to a member (CLIENT) only', async () => {
      const { service, user } = build();
      for (const role of ['FRONT_DESK', 'COACH', 'ADMIN', 'DEV']) {
        user.findFirst.mockResolvedValue({ ...ROW, role });
        expect((await service.get(USER_ID, NOW)).canDeleteAccount).toBe(false);
      }
    });

    it('404s a row that is gone', async () => {
      const { service, user } = build();
      user.findFirst.mockResolvedValue(null);
      const caught = await service.get(USER_ID).catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(DomainException);
      expect((caught as DomainException).getStatus()).toBe(HttpStatus.NOT_FOUND);
    });
  });

  describe('update', () => {
    it('writes only the fields that were sent', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { weightKg: 70.5 });
      expect(user.update).toHaveBeenCalledWith({
        where: { id: USER_ID },
        data: { weightKg: 70.5 },
        select: PROFILE_SELECT,
      });
    });

    it('writes a new name and phone', async () => {
      const { service, user } = build();
      const saved = await service.update(
        USER_ID,
        { firstName: 'Juanito', lastName: 'Cruz', phone: '0917 555 0199' },
        NOW,
      );
      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { firstName: 'Juanito', lastName: 'Cruz', phone: '0917 555 0199' },
        }),
      );
      expect(saved).toMatchObject({ firstName: 'Juanito', lastName: 'Cruz' });
    });

    it('clears the phone with null', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { phone: null });
      expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { phone: null } }));
    });

    it('writes null to clear a value', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { heightCm: null, medicalNotes: null });
      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { heightCm: null, medicalNotes: null } }),
      );
    });

    it('returns the saved profile', async () => {
      const { service } = build();
      await expect(
        service.update(
          USER_ID,
          { heightCm: 180, weightKg: 80, medicalNotes: 'No overhead pressing' },
          NOW,
        ),
      ).resolves.toEqual({
        ...PROFILE,
        heightCm: 180,
        weightKg: 80,
        medicalNotes: 'No overhead pressing',
      });
    });

    it('writes the medical-notes opt-in', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { shareMedicalWithPlanner: true });
      expect(user.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { shareMedicalWithPlanner: true } }),
      );
    });

    it('an empty body writes nothing and returns the current profile', async () => {
      const { service, user } = build();
      await expect(service.update(USER_ID, {}, NOW)).resolves.toEqual(PROFILE);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('never writes email, whatever the object carries', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { weightKg: 70, email: 'x@example.com' } as never);
      expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { weightKg: 70 } }));
    });
  });
});
