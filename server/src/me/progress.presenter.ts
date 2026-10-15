import { civilDateFromPrisma, civilDaysBetween, type CivilDate } from '../common/time/gym-time';

/**
 * Progress, projected and summarised.
 *
 * PURE below the two `to*` functions, so the arithmetic that decides whether a
 * member is told they have lost or gained weight is tested as arithmetic
 * rather than sampled through a database.
 *
 * EVERY NUMBER STAYS AN INTEGER on the wire. Grams, millimetres, per mille and
 * hundredths — never a float, and never a pre-formatted "72.4 kg". The client
 * divides and formats, the same division of labour money follows with
 * centavos: one surface renders "72.4 kg", another renders "72,400 g", and
 * neither can disagree with the stored value.
 *
 * PROVENANCE IS A FIRST NAME, NEVER AN ID. `recordedBy` answers "who took
 * this reading" for a member reading their own history, and "Coach Ana" is the
 * whole of that answer. A user id on the wire would be a handle for nothing a
 * member can do — no member route takes one — and an input for enumeration.
 */

/** The coach, as far as a member's screen needs them. */
export interface ProgressPerson {
  firstName: string;
}

/**
 * The select every progress read uses, so the recorder names cannot drift
 * between the member's summary and the coach's drill-down.
 */
export const PROGRESS_PEOPLE_SELECT = {
  recordedBy: { select: { firstName: true } },
  updatedBy: { select: { firstName: true } },
} as const;

interface Provenance {
  /** NULL is the ONLY spelling of self-recorded. */
  recordedById: string | null;
  updatedById: string | null;
  recordedBy: ProgressPerson | null;
  updatedBy: ProgressPerson | null;
}

export interface MeasurementRow extends Provenance {
  id: string;
  businessDate: Date;
  weightGrams: number | null;
  heightMm: number | null;
  bodyFatPermille: number | null;
  notes: string | null;
}

interface ProvenanceDto {
  /** Null means the member recorded it themselves, before coaches did. */
  recordedBy: ProgressPerson | null;
  /** Set only when a DIFFERENT person corrected it after the recorder. */
  updatedBy: ProgressPerson | null;
}

export interface MeasurementDto extends ProvenanceDto {
  id: string;
  businessDate: CivilDate;
  weightGrams: number | null;
  heightMm: number | null;
  bodyFatPermille: number | null;
  notes: string | null;
}

export interface GoalRow extends Provenance {
  id: string;
  name: string;
  unit: string;
  startHundredths: number;
  currentHundredths: number;
  targetHundredths: number;
  achievedAt: Date | null;
}

export interface MemberGoalDto extends ProvenanceDto {
  id: string;
  name: string;
  unit: string;
  startHundredths: number;
  currentHundredths: number;
  targetHundredths: number;
  /** 0-100, clamped. Computed here so every surface shows the same ring. */
  percent: number;
  achievedAt: string | null;
}

/** The member's currently assigned coach — the person who records for them. */
export interface ProgressCoach {
  firstName: string;
  lastName: string;
}

export interface ProgressSummary {
  measurements: MeasurementDto[];
  goals: MemberGoalDto[];
  latestWeightGrams: number | null;
  /** Signed. Negative is a loss. Null when there is nothing to compare against. */
  changeGrams: number | null;
  /** How many days the change is measured over, so the UI can say "over 90 days". */
  changeOverDays: number | null;
  /** Thousandths, so 24.3 is 24300. Null unless BOTH a weight and a height are known. */
  bmiThousandths: number | null;
  /**
   * Null when the member has no active coach — or their coach's account was
   * soft-deleted — which is what the page's coaching explainer keys on.
   */
  coach: ProgressCoach | null;
}

/**
 * Names only, and the updater only when it is somebody else: "recorded by Ana
 * · updated by Ana" says the same thing twice.
 */
function provenance(row: Provenance): ProvenanceDto {
  const recordedBy = row.recordedBy === null ? null : { firstName: row.recordedBy.firstName };
  const updatedBy =
    row.updatedBy === null || row.updatedById === row.recordedById
      ? null
      : { firstName: row.updatedBy.firstName };
  return { recordedBy, updatedBy };
}

export function toMeasurement(row: MeasurementRow): MeasurementDto {
  return {
    id: row.id,
    // The ONLY sanctioned way to read a @db.Date back — it arrives at UTC
    // midnight and any other accessor is a day out for half the year.
    businessDate: civilDateFromPrisma(row.businessDate),
    weightGrams: row.weightGrams,
    heightMm: row.heightMm,
    bodyFatPermille: row.bodyFatPermille,
    notes: row.notes,
    ...provenance(row),
  };
}

export function toGoal(row: GoalRow): MemberGoalDto {
  return {
    id: row.id,
    name: row.name,
    unit: row.unit,
    startHundredths: row.startHundredths,
    currentHundredths: row.currentHundredths,
    targetHundredths: row.targetHundredths,
    percent: goalPercent(row),
    achievedAt: row.achievedAt?.toISOString() ?? null,
    ...provenance(row),
  };
}

/**
 * Progress towards a target, as a percentage of the distance from the start.
 *
 * MEASURED FROM THE START, NOT FROM ZERO, which is what makes a downward goal
 * work at all: "95 kg down to 85 kg, currently 90" is 50% done. A naive
 * `current / target` would call that 106% — and would tell a member trying to
 * lose weight that they had overshot while they were still halfway.
 *
 * The database forbids `target === start`, so the denominator is never zero.
 */
function goalPercent(
  goal: Pick<GoalRow, 'startHundredths' | 'currentHundredths' | 'targetHundredths'>,
): number {
  const span = goal.targetHundredths - goal.startHundredths;
  if (span === 0) return 0;

  const done = goal.currentHundredths - goal.startHundredths;
  return Math.max(0, Math.min(100, Math.round((done / span) * 100)));
}

export function summarise(
  measurements: readonly MeasurementDto[],
  goals: readonly MemberGoalDto[],
  _today: CivilDate,
  coach: ProgressCoach | null = null,
): ProgressSummary {
  // Only entries that actually carry a weight — a height-only row must not
  // become a point on the weight trend.
  const weighed = measurements.filter(
    (m): m is MeasurementDto & { weightGrams: number } => m.weightGrams !== null,
  );

  const first = weighed[0] ?? null;
  const latest = weighed[weighed.length - 1] ?? null;

  // A single weigh-in is not a trend. Reporting "0 kg change" from one entry
  // reads as "you have made no progress" rather than "there is nothing to
  // compare yet", which is the opposite of true for somebody on day one.
  const hasTrend = first !== null && latest !== null && first.id !== latest.id;

  return {
    measurements: [...measurements],
    goals: [...goals],
    latestWeightGrams: latest?.weightGrams ?? null,
    changeGrams: hasTrend ? latest.weightGrams - first.weightGrams : null,
    changeOverDays: hasTrend ? civilDaysBetween(first.businessDate, latest.businessDate) : null,
    bmiThousandths: bmi(latest, measurements),
    coach,
  };
}

/**
 * BMI in thousandths — 24.3 becomes 24300.
 *
 * Height comes from the most recent entry that HAS one, not from the latest
 * entry: members record height rarely and weight often, so requiring both on
 * the same row would leave BMI null for everyone who ever weighed themselves
 * without re-measuring their height.
 */
function bmi(
  latest: (MeasurementDto & { weightGrams: number }) | null,
  all: readonly MeasurementDto[],
): number | null {
  if (latest === null) return null;

  const withHeight = [...all].reverse().find((m) => m.heightMm !== null);
  if (withHeight?.heightMm == null) return null;

  const metres = withHeight.heightMm / 1000;
  const kg = latest.weightGrams / 1000;
  return Math.round((kg / (metres * metres)) * 1000);
}
