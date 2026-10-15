import request from 'supertest';
import type { Server } from 'http';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';
import { resetDatabase } from './support/db';
import { makeMember, seedPlansForTest } from './support/membership-fixtures';
import { MembershipNightlyJob } from '../src/membership/membership-nightly.job';
import {
  addDays,
  asCivilDate,
  civilDateFromPrisma,
  toDateColumn,
} from '../src/common/time/gym-time';

jest.setTimeout(120_000);

const TODAY = asCivilDate('2026-08-19');
const NOW = new Date('2026-08-19T19:15:00.000Z'); // 03:15 Manila on 2026-08-20 is a different day

describe('membership nightly job (route 41, spec 5.9)', () => {
  let ctx: TestApp;
  let server: Server;
  let job: MembershipNightlyJob;
  let adminToken: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as Server;
    job = ctx.app.get(MembershipNightlyJob, { strict: false });
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await seedPlansForTest(ctx.prisma);
    adminToken = await ctx.fixture.tokenFor('ADMIN', { supabaseId: FIXTURE_IDS.ADMIN });
  });

  it('expires a lapsed term and is a no-op on a second run', async () => {
    // startsOn must precede the endsOn override below, or the fixture write
    // itself violates Membership_dates_ordered — so the fixture's `today` is
    // well before TODAY, not TODAY itself.
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: addDays(TODAY, -35),
    });
    await ctx.prisma.membership.update({
      where: { id: member.membershipId! },
      data: { endsOn: toDateColumn(addDays(TODAY, -1)) },
    });

    const first = await job.runFor(TODAY, NOW);
    expect(first.steps.find((s) => s.step === 'expireLapsedTerms')).toMatchObject({ changed: 1 });

    const afterFirst = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(afterFirst.status).toBe('EXPIRED');
    expect(civilDateFromPrisma(afterFirst.endsOn)).toBe(addDays(TODAY, -1));

    const second = await job.runFor(TODAY, NOW);
    expect(second.steps.find((s) => s.step === 'expireLapsedTerms')).toMatchObject({ changed: 0 });

    const events = await ctx.prisma.membershipEvent.findMany({ where: { type: 'EXPIRED' } });
    expect(events).toHaveLength(1);
    expect(events[0].actorId).toBeNull();
    expect(events[0].effectiveAt.toISOString().slice(0, 10)).toBe(TODAY);
  });

  it('closes a term under notice before it can be briefly EXPIRED', async () => {
    // Same reasoning as above: startsOn must precede the endsOn override.
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: addDays(TODAY, -35),
    });
    const endsOn = addDays(TODAY, -2);
    await ctx.prisma.membership.update({
      where: { id: member.membershipId! },
      data: {
        endsOn: toDateColumn(endsOn),
        cancelRequestedOn: toDateColumn(addDays(TODAY, -10)),
      },
    });

    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('CANCELLED');
    expect(civilDateFromPrisma(after.cancelledOn!)).toBe(addDays(endsOn, 1));
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'EXPIRED' } })).toBe(0);
  });

  it('activates a scheduled hold exactly once, extending endsOn day for day', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'QUARTERLY',
      today: TODAY,
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    const adminId = await ctx.fixture.userIdFor(FIXTURE_IDS.ADMIN);
    await ctx.prisma.membershipHold.create({
      data: {
        membershipId: member.membershipId!,
        status: 'SCHEDULED',
        startsOn: toDateColumn(TODAY),
        endsOn: toDateColumn(addDays(TODAY, 13)),
        daysRequested: 14,
        daysApplied: 0,
        reason: 'booked last week',
        approvedById: adminId,
      },
    });

    await job.runFor(TODAY, NOW);
    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('FROZEN');
    expect(civilDateFromPrisma(after.endsOn)).toBe(addDays(civilDateFromPrisma(before.endsOn), 14));
    expect(after.freezesUsedThisTerm).toBe(1);
    expect(await ctx.prisma.membershipEvent.count({ where: { type: 'HOLD_APPLIED' } })).toBe(1);
  });

  it('completes a finished hold with no date arithmetic at all', async () => {
    // The fixture's own hold starts on `today`; it must precede the endsOn
    // override below or the fixture write violates MembershipHold_dates_ordered.
    const member = await makeMember(ctx.prisma, {
      state: 'FROZEN',
      planCode: 'QUARTERLY',
      today: addDays(TODAY, -30),
    });
    const before = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    await ctx.prisma.membershipHold.updateMany({
      where: { membershipId: member.membershipId! },
      data: { endsOn: toDateColumn(addDays(TODAY, -1)) },
    });

    await job.runFor(TODAY, NOW);

    const after = await ctx.prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId! },
    });
    expect(after.status).toBe('ACTIVE');
    expect(civilDateFromPrisma(after.endsOn)).toBe(civilDateFromPrisma(before.endsOn));

    const hold = await ctx.prisma.membershipHold.findFirstOrThrow({
      where: { membershipId: member.membershipId! },
    });
    expect(hold.status).toBe('COMPLETED');
    expect(hold.activeMembershipId).toBeNull();
  });

  it('a three-day catch-up equals three sequential nightly runs', async () => {
    // startsOn must precede the endsOn override below.
    const catchUp = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: addDays(TODAY, -35),
    });
    const sequential = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: addDays(TODAY, -35),
    });
    await ctx.prisma.membership.updateMany({
      where: { id: { in: [catchUp.membershipId!, sequential.membershipId!] } },
      data: { endsOn: toDateColumn(addDays(TODAY, -3)) },
    });
    // Only the sequential member gets a run on each of the three missed days.
    await job.runFor(addDays(TODAY, -2), NOW);
    await job.runFor(addDays(TODAY, -1), NOW);
    await job.runFor(TODAY, NOW);

    const rows = await ctx.prisma.membership.findMany({
      where: { id: { in: [catchUp.membershipId!, sequential.membershipId!] } },
      select: { id: true, status: true, endsOn: true },
    });
    expect(rows[0].status).toBe(rows[1].status);
    expect(civilDateFromPrisma(rows[0].endsOn)).toBe(civilDateFromPrisma(rows[1].endsOn));

    // effectiveAt is the day it SHOULD have happened, not the day it was noticed.
    const expired = await ctx.prisma.membershipEvent.findMany({ where: { type: 'EXPIRED' } });
    expect(expired).toHaveLength(2);
    for (const event of expired) {
      expect(event.effectiveAt.toISOString().slice(0, 10)).toBe(addDays(TODAY, -2));
    }
  });

  it('exposes the manual trigger at route 41 behind job.run and confirm', async () => {
    const unconfirmed = await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: false })
      .expect(400);
    expect(unconfirmed.body.error.code).toBe('CONFIRMATION_REQUIRED');

    const response = await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ confirm: true, runFor: TODAY })
      .expect(201);

    expect(response.body.data.runFor).toBe(TODAY);
    expect(response.body.data.steps.map((s: { step: string }) => s.step)).toEqual([
      'completeFinishedHolds',
      'activateScheduledHolds',
      'closeTermsUnderNotice',
      'expireLapsedTerms',
      'reconcileHoldArithmetic',
      'emitOwnerSummary',
    ]);

    const deskToken = await ctx.fixture.tokenFor('FRONT_DESK', {
      supabaseId: FIXTURE_IDS.FRONT_DESK,
    });
    await request(server)
      .post('/api/v1/admin/jobs/membership-nightly')
      .set('Authorization', `Bearer ${deskToken}`)
      .send({ confirm: true })
      .expect(403);
  });

  it('hands a populated owner summary for YESTERDAY to the transport in one line', async () => {
    const member = await makeMember(ctx.prisma, {
      state: 'ACTIVE',
      planCode: 'MONTHLY',
      today: TODAY,
    });
    expect(member.membershipId).not.toBeNull();

    const result = await job.runFor(TODAY, NOW);
    const step = result.steps.find((s) => s.step === 'emitOwnerSummary');

    expect(step).toMatchObject({ matched: 1, changed: 0 });
    expect(step!.note).toBe(`summary sent for ${addDays(TODAY, -1)}`);
  });
});
