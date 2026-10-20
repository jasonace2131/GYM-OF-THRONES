import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { MyProfile } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import type { UpdateMyProfileDto } from './dto/update-my-profile.dto';

const PROFILE_SELECT = {
  email: true,
  heightCm: true,
  weightKg: true,
  medicalNotes: true,
  shareMedicalWithPlanner: true,
} as const satisfies Prisma.UserSelect;

/**
 * The caller's own account page: body metrics and medical notes.
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
 * height is not an action anybody reviews.
 */
@Injectable()
export class MyProfileService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<MyProfile> {
    const row = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: PROFILE_SELECT,
    });
    if (row === null) {
      throw new DomainException('MEMBER_NOT_FOUND', 'Account not found.', HttpStatus.NOT_FOUND);
    }
    return row;
  }

  /** Only the fields that were sent change; `null` clears one. Never email. */
  async update(userId: string, dto: UpdateMyProfileDto): Promise<MyProfile> {
    const data: Prisma.UserUpdateInput = {
      ...(dto.heightCm === undefined ? {} : { heightCm: dto.heightCm }),
      ...(dto.weightKg === undefined ? {} : { weightKg: dto.weightKg }),
      ...(dto.medicalNotes === undefined ? {} : { medicalNotes: dto.medicalNotes }),
      ...(dto.shareMedicalWithPlanner === undefined
        ? {}
        : { shareMedicalWithPlanner: dto.shareMedicalWithPlanner }),
    };
    if (Object.keys(data).length === 0) return this.get(userId);

    return this.prisma.user.update({ where: { id: userId }, data, select: PROFILE_SELECT });
  }
}
