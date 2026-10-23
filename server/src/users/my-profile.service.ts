import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { MyProfile } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { GymConfigService } from '../config/gym.config';
import { civilDateFromPrisma, civilDaysBetween, gymToday } from '../common/time/gym-time';
import type { UpdateMyProfileDto } from './dto/update-my-profile.dto';

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
  // Read for `canDeleteAccount` only; never sent.
  role: true,
  membership: { select: { planName: true, status: true, endsOn: true } },
} as const satisfies Prisma.UserSelect;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof PROFILE_SELECT }>;

/**
 * The caller's own account page: name, phone, member code, body metrics,
 * medical notes and a one-line membership summary.
 *
 * Keyless like the rest of `/me` — the subject is always `request.user.id`,
 * and no parameter could name anybody else.
 *
 * `medicalNotes` is sensitive personal information (RA 10173 §3(l)). It leaves
 * the database here, to its owner, and to the AI planner's prompts ONLY when
 * the member has ticked `shareMedicalWithPlanner`; it is NOT in `DeskMember`
 * or any list.
 *
 * NO AUDIT LINE, deliberately: the staff edit of a member's profile
 * (`MembersService.update`) writes none either, and a person editing their own
 * height or phone is not an action anybody reviews.
 */
@Injectable()
export class MyProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  async get(userId: string, now: Date = new Date()): Promise<MyProfile> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Account not found.', HttpStatus.NOT_FOUND);
    }
    return this.present(row, now);
  }

  /**
   * Only the fields that were sent change; `null` clears one. Never email.
   * A name is never cleared — the DTO refuses `null` for it.
   */
  async update(userId: string, dto: UpdateMyProfileDto, now: Date = new Date()): Promise<MyProfile> {
    const data: Prisma.UserUpdateInput = {
      ...(dto.firstName === undefined ? {} : { firstName: dto.firstName }),
      ...(dto.lastName === undefined ? {} : { lastName: dto.lastName }),
      ...(dto.phone === undefined ? {} : { phone: dto.phone }),
      ...(dto.heightCm === undefined ? {} : { heightCm: dto.heightCm }),
      ...(dto.weightKg === undefined ? {} : { weightKg: dto.weightKg }),
      ...(dto.medicalNotes === undefined ? {} : { medicalNotes: dto.medicalNotes }),
      ...(dto.shareMedicalWithPlanner === undefined
        ? {}
        : { shareMedicalWithPlanner: dto.shareMedicalWithPlanner }),
    };
    if (Object.keys(data).length === 0) return this.get(userId, now);

    const row = await this.prisma.user.update({
      where: { id: userId },
      data,
      select: PROFILE_SELECT,
    });
    return this.present(row, now);
  }

  private present(row: ProfileRow, now: Date): MyProfile {
    const { role, membership, ...profile } = row;
    let summary: MyProfile['membership'] = null;
    if (membership !== null) {
      const endsOn = civilDateFromPrisma(membership.endsOn);
      summary = {
        planName: membership.planName,
        status: membership.status,
        endsOn,
        daysLeft: Math.max(0, civilDaysBetween(gymToday(now, this.gym.timeZone), endsOn)),
      };
    }
    return { ...profile, membership: summary, canDeleteAccount: role === 'CLIENT' };
  }
}
