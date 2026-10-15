import { BadRequestException, HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { AuditService } from '../audit/audit.service';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  asCivilDate,
  civilDateFromPrisma,
  civilDaysBetween,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import type { AuthUser } from '../auth/auth.types';
import type { ScopedWhere } from '../rbac/scope.util';
import type { MemberGoalDto, MeasurementDto, ProgressSummary } from './progress.presenter';
import { PROGRESS_PEOPLE_SELECT, toGoal, toMeasurement, summarise } from './progress.presenter';
import type { RecordMeasurementDto, UpdateMeasurementDto } from './dto/record-measurement.dto';
import type { CreateGoalDto, UpdateGoalDto } from './dto/goal.dto';

/**
 * The only two facts about the caller this service may use. Passing the whole
 * AuthUser would invite re-deriving access from `role`, which is the guard's
 * job — `role` is here solely to be snapshotted onto audit entries.
 */
export type ProgressActor = Pick<AuthUser, 'id' | 'role'>;

/** The member card on the coach's drill-down. Nothing a coach does not need. */
export interface ProgressMember {
  id: string;
  firstName: string;
  lastName: string;
  memberCode: string | null;
}

export type CoachMemberProgress = { member: ProgressMember } & ProgressSummary;

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/** The three readings. `notes` is not one: a date and a note is not a measurement. */
const READINGS = ['weightGrams', 'heightMm', 'bodyFatPermille'] as const;
const MEASUREMENT_FIELDS = [...READINGS, 'notes'] as const;
type MeasurementField = (typeof MEASUREMENT_FIELDS)[number];

interface MeasurementValues {
  weightGrams: number | null;
  heightMm: number | null;
  bodyFatPermille: number | null;
  notes: string | null;
}

/**
 * Members' body data, recorded by their assigned coach.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO AUDIENCES, TWO KINDS OF METHOD.
 *
 * `summary(userId)` is the member reading their own progress: keyless, like
 * the rest of `/me`, with the subject taken from the token by the controller.
 *
 * Everything else is a COACH acting on a member, and takes the member as a
 * parameter — which is exactly why each of those methods also takes a
 * `ScopedWhere` and runs it through `memberInScope` before touching a row.
 * The scope is the `coachedMember` subject: an ACTIVE assignment to the
 * caller, a live account, and NO self branch.
 *
 * Owner decision (2026-09): members became read-only. Only the member's
 * currently assigned coach records — not admins, not the desk — and if a coach
 * leaves, nobody can add or correct entries until a new one is assigned. DEV
 * keeps its documented superuser bypass (its grant is ALL, so the scope is
 * just "not deleted").
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * SELF-RECORDED ROWS ARE FROZEN (D2). `recordedById` NULL is how a row the
 * member entered themselves, before this change, is spelled. A coach may
 * delete one, and the delete is audited; a coach may never edit one or write
 * over its day — both are a 409, backed by `*_updater_shape` in the database.
 *
 * AUDIT: corrections and deletions only (D4), and `details` names FIELDS,
 * never values. Admins hold `audit.read` and no progress key, so a weight in
 * an audit entry would be the one place an admin could read it.
 */
@Injectable()
export class ProgressService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly audit: AuditService,
  ) {}

  /** A member's progress. The caller has already decided who may see it. */
  async summary(userId: string, now: Date = new Date()): Promise<ProgressSummary> {
    const [measurements, goals, assignment] = await Promise.all([
      this.prisma.bodyMeasurement.findMany({
        where: { userId },
        // Oldest first: the trend chart reads left to right, and reversing in
        // the presenter would mean two orderings to keep in step.
        orderBy: { businessDate: 'asc' },
        // A year of daily weigh-ins. Beyond that the chart is unreadable and
        // the payload is paid for and thrown away.
        take: 400,
        include: PROGRESS_PEOPLE_SELECT,
      }),
      this.prisma.memberGoal.findMany({
        where: { userId },
        // Unachieved first, newest within each group.
        orderBy: [{ achievedAt: 'asc' }, { createdAt: 'desc' }],
        include: PROGRESS_PEOPLE_SELECT,
      }),
      // The nullable-unique sentinel: at most one ACTIVE coach per member.
      this.prisma.coachAssignment.findUnique({
        where: { activeMemberId: userId },
        select: { coach: { select: { firstName: true, lastName: true, deletedAt: true } } },
      }),
    ]);

    // A soft-deleted coach is nobody's coach: the member is told to ask for a
    // new one rather than shown the name of an account that cannot record.
    const coach =
      assignment === null || assignment.coach.deletedAt !== null
        ? null
        : { firstName: assignment.coach.firstName, lastName: assignment.coach.lastName };

    return summarise(
      measurements.map(toMeasurement),
      goals.map(toGoal),
      gymToday(now, this.gym.timeZone),
      coach,
    );
  }

  /** The coach's drill-down: the member card, then the same summary they see. */
  async memberProgress(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    now: Date = new Date(),
  ): Promise<CoachMemberProgress> {
    const member = await this.memberInScope(actor, memberId, scope);
    return { member, ...(await this.summary(member.id, now)) };
  }

  /**
   * Record a reading for one day, MERGING into that day if it exists.
   *
   * THE BUG THIS REPLACES: the old member route upserted with `?? null` for
   * every omitted field, so a height recorded after the morning's weight wiped
   * the weight. Only the fields actually sent are written, and an explicit
   * null on a POST means "not given", never "clear" — clearing is PATCH's job.
   */
  async recordMeasurement(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    dto: RecordMeasurementDto,
    now: Date = new Date(),
  ): Promise<MeasurementDto> {
    const member = await this.memberInScope(actor, memberId, scope);

    const given = pickPresent(dto, { keepNull: false });
    if (!READINGS.some((field) => given[field] !== undefined)) throw measurementEmpty();

    const date = this.readingDate(dto.businessDate, now);
    const key = { userId_businessDate: { userId: member.id, businessDate: toDateColumn(date) } };

    const existing = await this.prisma.bodyMeasurement.findUnique({ where: key });
    if (existing !== null && existing.recordedById === null) throw selfRecorded('measurement');

    const row = await this.prisma.bodyMeasurement.upsert({
      where: key,
      create: {
        userId: member.id,
        businessDate: toDateColumn(date),
        ...given,
        recordedById: actor.id,
      },
      // Only what was sent, plus who sent it. Never a field it was not given.
      update: { ...given, updatedById: actor.id },
      include: PROGRESS_PEOPLE_SELECT,
    });

    if (existing !== null) {
      const fields = correctedFields(existing, given);
      if (fields.length > 0) {
        await this.audit.record({
          action: 'PROGRESS_MEASUREMENT_CORRECTED',
          actorId: actor.id,
          actorRole: actor.role,
          subjectType: 'BodyMeasurement',
          subjectId: row.id,
          subjectLabel: fullName(member),
          details: { memberId: member.id, businessDate: date, fields },
        });
      }
    }

    return toMeasurement(row);
  }

  /** Correct one recorded day. An explicit null clears a field. */
  async updateMeasurement(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    id: string,
    dto: UpdateMeasurementDto,
  ): Promise<MeasurementDto> {
    const member = await this.memberInScope(actor, memberId, scope);
    const existing = await this.prisma.bodyMeasurement.findFirst({
      where: { id, userId: member.id },
      include: PROGRESS_PEOPLE_SELECT,
    });
    if (existing === null) throw new NotFoundException('Measurement not found');
    if (existing.recordedById === null) throw selfRecorded('measurement');

    const patch = pickPresent(dto, { keepNull: true });
    // Nothing to change is not an error, and not a correction either.
    if (Object.keys(patch).length === 0) return toMeasurement(existing);

    const merged = { ...pickValues(existing), ...patch };
    if (READINGS.every((field) => merged[field] === null)) throw measurementEmpty();

    const row = await this.prisma.bodyMeasurement.update({
      where: { id: existing.id },
      data: { ...patch, updatedById: actor.id },
      include: PROGRESS_PEOPLE_SELECT,
    });

    const fields = correctedFields(existing, patch);
    if (fields.length > 0) {
      await this.audit.record({
        action: 'PROGRESS_MEASUREMENT_CORRECTED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'BodyMeasurement',
        subjectId: existing.id,
        subjectLabel: fullName(member),
        details: {
          memberId: member.id,
          businessDate: civilDateFromPrisma(existing.businessDate),
          fields,
        },
      });
    }

    return toMeasurement(row);
  }

  /**
   * Delete one day. The one write a coach may make to a self-recorded row
   * (D2), so the audit entry says which kind it was.
   */
  async removeMeasurement(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    id: string,
  ): Promise<{ id: string }> {
    const member = await this.memberInScope(actor, memberId, scope);
    const existing = await this.prisma.bodyMeasurement.findFirst({
      where: { id, userId: member.id },
    });
    if (existing === null) throw new NotFoundException('Measurement not found');

    // Scoped in the WHERE again, so a row that moved between the read and the
    // delete is a 404 rather than somebody else's data.
    const { count } = await this.prisma.bodyMeasurement.deleteMany({
      where: { id: existing.id, userId: member.id },
    });
    if (count === 0) throw new NotFoundException('Measurement not found');

    await this.audit.record({
      action: 'PROGRESS_MEASUREMENT_DELETED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'BodyMeasurement',
      subjectId: existing.id,
      subjectLabel: fullName(member),
      details: {
        memberId: member.id,
        businessDate: civilDateFromPrisma(existing.businessDate),
        selfRecorded: existing.recordedById === null,
        fields: MEASUREMENT_FIELDS.filter((field) => existing[field] !== null),
      },
    });

    return { id: existing.id };
  }

  async createGoal(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    dto: CreateGoalDto,
  ): Promise<MemberGoalDto> {
    const member = await this.memberInScope(actor, memberId, scope);
    if (dto.targetHundredths === dto.startHundredths) throw goalHasNoSpan();

    const row = await this.prisma.memberGoal.create({
      data: {
        userId: member.id,
        name: dto.name,
        unit: dto.unit,
        startHundredths: dto.startHundredths,
        // A new goal starts where the member is now.
        currentHundredths: dto.startHundredths,
        targetHundredths: dto.targetHundredths,
        recordedById: actor.id,
      },
      include: PROGRESS_PEOPLE_SELECT,
    });
    return toGoal(row);
  }

  /** Progress on a goal is routine, so it is attributed but not audited. */
  async updateGoal(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    id: string,
    dto: UpdateGoalDto,
  ): Promise<MemberGoalDto> {
    const member = await this.memberInScope(actor, memberId, scope);
    const existing = await this.prisma.memberGoal.findFirst({
      where: { id, userId: member.id },
      select: { id: true, recordedById: true, startHundredths: true },
    });
    if (existing === null) throw new NotFoundException('Goal not found');
    if (existing.recordedById === null) throw selfRecorded('goal');
    if (dto.targetHundredths !== undefined && dto.targetHundredths === existing.startHundredths) {
      throw goalHasNoSpan();
    }

    const row = await this.prisma.memberGoal.update({
      where: { id: existing.id },
      data: {
        ...(dto.name === undefined ? {} : { name: dto.name }),
        ...(dto.currentHundredths === undefined
          ? {}
          : { currentHundredths: dto.currentHundredths }),
        ...(dto.targetHundredths === undefined ? {} : { targetHundredths: dto.targetHundredths }),
        // `achieved: false` must clear the timestamp, so this branches on
        // undefined rather than on truthiness — a goal ticked by mistake has
        // to be un-tickable.
        ...(dto.achieved === undefined ? {} : { achievedAt: dto.achieved ? new Date() : null }),
        updatedById: actor.id,
      },
      include: PROGRESS_PEOPLE_SELECT,
    });

    return toGoal(row);
  }

  async removeGoal(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
    id: string,
  ): Promise<{ id: string }> {
    const member = await this.memberInScope(actor, memberId, scope);
    const existing = await this.prisma.memberGoal.findFirst({
      where: { id, userId: member.id },
      select: { id: true, name: true, recordedById: true },
    });
    if (existing === null) throw new NotFoundException('Goal not found');

    const { count } = await this.prisma.memberGoal.deleteMany({
      where: { id: existing.id, userId: member.id },
    });
    if (count === 0) throw new NotFoundException('Goal not found');

    await this.audit.record({
      action: 'PROGRESS_GOAL_DELETED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'MemberGoal',
      subjectId: existing.id,
      subjectLabel: existing.name,
      details: { memberId: member.id, selfRecorded: existing.recordedById === null },
    });

    return { id: existing.id };
  }

  /**
   * The ONE gate every coach method goes through.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ONE 404, WORD FOR WORD, FOR EVERY WAY OF NOT BEING MINE.
   *
   * The member does not exist, is somebody else's, their assignment ended,
   * their account was deleted, or it is the caller's own id — all five arrive
   * as the same response. A distinct message for any of them would turn this
   * route into an oracle for which ids are real and who coaches whom.
   *
   * The caller's own id is refused BEFORE the query (D3): the scope has no
   * self branch anyway, but DEV's scope is ALL, and a coach recording their
   * own progress is also forbidden by `*_recorder_not_member` in the database.
   * ═══════════════════════════════════════════════════════════════════════════
   */
  private async memberInScope(
    actor: ProgressActor,
    memberId: string,
    scope: MemberScope,
  ): Promise<ProgressMember> {
    if (memberId === actor.id) throw memberNotFound();

    const member = await this.prisma.user.findFirst({
      // ANDed, never spread: a spread would clobber the scope's own keys.
      where: { AND: [{ id: memberId }, scope] },
      select: { id: true, firstName: true, lastName: true, memberCode: true },
    });
    if (member === null) throw memberNotFound();
    return member;
  }

  /**
   * The day a reading is filed under: today in the gym's zone by default, an
   * earlier day to backfill, never a future one — a reading dated tomorrow
   * would become the "current weight" on every screen until tomorrow came.
   */
  private readingDate(requested: string | undefined, now: Date): CivilDate {
    const today = gymToday(now, this.gym.timeZone);
    if (requested === undefined) return today;

    let date: CivilDate;
    try {
      date = asCivilDate(requested);
    } catch {
      throw new BadRequestException('businessDate is not a real calendar date');
    }
    if (civilDaysBetween(today, date) > 0) {
      throw new BadRequestException('A reading cannot be dated in the future');
    }
    return date;
  }
}

function memberNotFound(): DomainException {
  return new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
}

function measurementEmpty(): DomainException {
  return new DomainException(
    'MEASUREMENT_EMPTY',
    'Record at least one of weight, height or body fat',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function goalHasNoSpan(): DomainException {
  return new DomainException(
    'GOAL_TARGET_EQUALS_START',
    'The target has to differ from the starting value',
    HttpStatus.UNPROCESSABLE_ENTITY,
  );
}

function selfRecorded(what: 'measurement' | 'goal'): DomainException {
  return new DomainException(
    'PROGRESS_SELF_RECORDED',
    `This ${what} was recorded by the member before coaches recorded progress. It can be deleted, not edited.`,
    HttpStatus.CONFLICT,
  );
}

function fullName(member: ProgressMember): string {
  return `${member.firstName} ${member.lastName}`.trim();
}

/**
 * The fields a request actually carried. On a POST an explicit null is "not
 * given" (`keepNull: false`); on a PATCH it is "clear this" (`keepNull: true`).
 */
function pickPresent(
  source: { [K in MeasurementField]?: MeasurementValues[K] },
  options: { keepNull: boolean },
): Partial<MeasurementValues> {
  const out: Partial<MeasurementValues> = {};
  const take = <K extends MeasurementField>(field: K): void => {
    const value = source[field];
    if (value === undefined || (value === null && !options.keepNull)) return;
    out[field] = value;
  };
  for (const field of MEASUREMENT_FIELDS) take(field);
  return out;
}

function pickValues(row: MeasurementValues): MeasurementValues {
  return {
    weightGrams: row.weightGrams,
    heightMm: row.heightMm,
    bodyFatPermille: row.bodyFatPermille,
    notes: row.notes,
  };
}

/**
 * The fields whose RECORDED value changed — the definition of a correction.
 *
 * Filling a field the day did not have yet (a height after the morning's
 * weight) corrects nothing, and re-sending the same value changes nothing, so
 * neither is audited. Overwriting or clearing a value that was there is.
 * Names only, in a fixed order, so two entries for the same change compare
 * equal.
 */
function correctedFields(
  before: MeasurementValues,
  after: Partial<MeasurementValues>,
): MeasurementField[] {
  return MEASUREMENT_FIELDS.filter(
    (field) =>
      after[field] !== undefined && before[field] !== null && before[field] !== after[field],
  );
}
