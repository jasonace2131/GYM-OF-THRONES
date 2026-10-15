/**
 * Demo data, for testing screens that need history to look like anything.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT THIS DELIBERATELY DOES NOT CREATE: PAYMENTS, MEMBERSHIPS, SHIFTS.
 *
 * This repository's dev database IS the production database — one Supabase
 * project, shared by `server/.env` and Railway. A seed that invented payment
 * rows would put money that never existed into the daily cash report, the
 * GCash reconciliation and the statutory-discount report, where a real person
 * would later have to work out which peso was fake. A membership would change
 * who the front door admits.
 *
 * So this writes only things that are the member's own and reversible:
 * announcements, body measurements and goals. Everything it creates is listed
 * on stdout with the exact command to undo it.
 *
 * ATTENDANCE IS NOT SEEDED EITHER, and the schema is the reason rather than
 * caution. `CheckIn_entry_shape` requires a `membershipId` and a
 * `membershipStatusAtTime` on a MEMBERSHIP visit; `CheckIn_shift_shape`
 * requires a `shiftId` on a MANUAL one. Faking attendance therefore means
 * faking a membership and an open cash shift — the two things above. To
 * exercise the dashboard's streak and heatmap, check in for real against a
 * station, or open a shift and record entries at the desk.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *   npm run seed:demo --workspace=server -- someone@example.com
 *   npm run seed:demo --workspace=server -- someone@example.com --undo
 *
 * The email is REQUIRED and there is no default. A seed script that picked its
 * own target is one `npm run` away from writing over somebody real.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Marks every row this script writes, so `--undo` can find them all. */
const DEMO_TAG = '[demo]';

const MS_PER_DAY = 86_400_000;

/** A `@db.Date` column wants UTC midnight — the same rule `toDateColumn` follows. */
function dateColumn(daysAgo: number): Date {
  const now = Date.now() - daysAgo * MS_PER_DAY;
  return new Date(`${new Date(now).toISOString().slice(0, 10)}T00:00:00.000Z`);
}

/**
 * Deterministic, so re-running produces the same history rather than a new
 * random one each time. `Math.random()` would make the trend chart change
 * shape on every seed and make a screenshot impossible to reproduce.
 */
function wobble(seed: number): number {
  return ((seed * 9301 + 49_297) % 233_280) / 233_280;
}

async function main(): Promise<void> {
  const [email, ...flags] = process.argv.slice(2);
  const undo = flags.includes('--undo');

  if (email === undefined || !email.includes('@')) {
    console.error('Usage: npm run seed:demo --workspace=server -- <email> [--undo]');
    console.error('The email is required — this script never picks its own target.');
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findFirst({
    where: { email },
    select: { id: true, firstName: true, lastName: true, email: true },
  });

  if (user === null) {
    console.error(`No user with email ${email}. Sign in once as that account first.`);
    process.exitCode = 1;
    return;
  }

  if (undo) {
    const [measurements, goals, announcements] = await prisma.$transaction([
      prisma.bodyMeasurement.deleteMany({ where: { userId: user.id, notes: DEMO_TAG } }),
      prisma.memberGoal.deleteMany({ where: { userId: user.id, name: { startsWith: DEMO_TAG } } }),
      prisma.announcement.deleteMany({ where: { content: { contains: DEMO_TAG } } }),
    ]);

    console.info(`Removed demo data for ${email}:`);
    console.info(`  ${measurements.count} measurements`);
    console.info(`  ${goals.count} goals`);
    console.info(`  ${announcements.count} announcements`);
    return;
  }

  console.info(`Seeding demo data for ${user.firstName} ${user.lastName} <${email}>`);

  // ── Body measurements: 26 weekly weigh-ins, trending down ──────────────
  //
  // A real trend, not a straight line: someone losing weight has weeks where
  // it goes back up, and a chart that never does looks fabricated because it
  // is. Height is recorded once, at the start, because that is what people do.
  const measurements = [];
  for (let week = 25; week >= 0; week -= 1) {
    const daysAgo = week * 7;
    const base = 92_000 - (25 - week) * 240;
    measurements.push({
      userId: user.id,
      businessDate: dateColumn(daysAgo),
      weightGrams: Math.round(base + (wobble(week) - 0.5) * 1400),
      heightMm: week === 25 ? 1750 : null,
      bodyFatPermille: Math.round(242 - (25 - week) * 1.6),
      notes: DEMO_TAG,
    });
  }

  const goals = [
    { name: `${DEMO_TAG} Lose weight`, unit: 'kg', start: 9200, current: 8600, target: 8500 },
    { name: `${DEMO_TAG} Bench press`, unit: 'kg', start: 6000, current: 7500, target: 10_000 },
    { name: `${DEMO_TAG} Visits this month`, unit: 'visits', start: 0, current: 9, target: 1200 },
  ];

  const announcements = [
    {
      title: 'Gym closes early this Saturday',
      content: `We close at 6pm on Saturday for floor maintenance. Normal hours resume Sunday. ${DEMO_TAG}`,
      isPinned: true,
    },
    {
      title: 'New squat racks on the second floor',
      content: `Two more racks are in. The old ones stay where they are. ${DEMO_TAG}`,
      isPinned: false,
    },
  ];

  // Clear this script's OWN rows first, so a re-run replaces rather than
  // accumulates.
  //
  // `skipDuplicates` alone is not enough and running it proved it: it can only
  // skip what a UNIQUE constraint identifies as a duplicate. Measurements have
  // @@unique([userId, businessDate]) and were correctly skipped; goals and
  // announcements have no unique key, so a second run silently doubled them —
  // 3 goals became 6, 2 announcements became 4.
  //
  // Scoped by DEMO_TAG, so a real goal or a real announcement written through
  // the app is never touched.
  await prisma.$transaction([
    prisma.memberGoal.deleteMany({ where: { userId: user.id, name: { startsWith: DEMO_TAG } } }),
    prisma.announcement.deleteMany({ where: { content: { contains: DEMO_TAG } } }),
  ]);

  const wroteMeasurements = await prisma.bodyMeasurement.createMany({
    data: measurements,
    skipDuplicates: true,
  });
  const wroteGoals = await prisma.memberGoal.createMany({
    data: goals.map((g) => ({
      userId: user.id,
      name: g.name,
      unit: g.unit,
      startHundredths: g.start,
      currentHundredths: g.current,
      targetHundredths: g.target,
    })),
    skipDuplicates: true,
  });
  const wroteAnnouncements = await prisma.announcement.createMany({
    data: announcements.map((a) => ({ ...a, authorId: user.id })),
    skipDuplicates: true,
  });

  console.info(`  ${wroteMeasurements.count} body measurements (26 weeks, trending down)`);
  console.info(`  ${wroteGoals.count} goals`);
  console.info(`  ${wroteAnnouncements.count} announcements`);
  console.info('');
  console.info('No payments, memberships, shifts or check-ins were created — those are');
  console.info('financial or operational records, and this database is the live one.');
  console.info('');
  console.info(`Undo:  npm run seed:demo --workspace=server -- ${email} --undo`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
