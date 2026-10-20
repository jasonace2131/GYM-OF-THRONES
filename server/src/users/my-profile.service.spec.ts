import { HttpStatus } from '@nestjs/common';
import { MyProfileService } from './my-profile.service';
import type { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';

const USER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const ROW = {
  email: 'juan@example.com',
  heightCm: 175,
  weightKg: 72.4,
  medicalNotes: 'Bad left knee',
  shareMedicalWithPlanner: false,
};

const PROFILE_SELECT = {
  email: true,
  heightCm: true,
  weightKg: true,
  medicalNotes: true,
  shareMedicalWithPlanner: true,
};

function build() {
  const user = {
    findFirst: jest.fn().mockResolvedValue(ROW),
    update: jest.fn().mockImplementation(({ data }: { data: object }) => ({ ...ROW, ...data })),
  };
  const service = new MyProfileService({ user } as unknown as PrismaService);
  return { service, user };
}

describe('MyProfileService', () => {
  describe('get', () => {
    it("reads the caller's own row, live and not soft-deleted, and only the four fields", async () => {
      const { service, user } = build();
      await expect(service.get(USER_ID)).resolves.toEqual(ROW);
      expect(user.findFirst).toHaveBeenCalledWith({
        where: { id: USER_ID, deletedAt: null },
        select: PROFILE_SELECT,
      });
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
        service.update(USER_ID, {
          heightCm: 180,
          weightKg: 80,
          medicalNotes: 'No overhead pressing',
        }),
      ).resolves.toEqual({
        ...ROW,
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
      await expect(service.update(USER_ID, {})).resolves.toEqual(ROW);
      expect(user.update).not.toHaveBeenCalled();
    });

    it('never writes email, whatever the object carries', async () => {
      const { service, user } = build();
      await service.update(USER_ID, { weightKg: 70, email: 'x@example.com' } as never);
      expect(user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { weightKg: 70 } }));
    });
  });
});
