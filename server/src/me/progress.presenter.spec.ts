import {
  summarise,
  toGoal,
  toMeasurement,
  type GoalRow,
  type MeasurementDto,
  type MeasurementRow,
} from './progress.presenter';
import type { CivilDate } from '../common/time/gym-time';

const TODAY = '2026-08-26' as CivilDate;

const weighIn = (
  id: string,
  date: string,
  grams: number,
  mm: number | null = null,
): MeasurementDto => ({
  id,
  businessDate: date as CivilDate,
  weightGrams: grams,
  heightMm: mm,
  bodyFatPermille: null,
  notes: null,
  recordedBy: null,
  updatedBy: null,
});

const ANA = '11111111-1111-4111-8111-111111111111';
const BEN = '22222222-2222-4222-8222-222222222222';

const measurementRow = (over: Partial<MeasurementRow> = {}): MeasurementRow => ({
  id: 'm1',
  businessDate: new Date('2026-09-24T00:00:00.000Z'),
  weightGrams: 72_400,
  heightMm: null,
  bodyFatPermille: null,
  notes: null,
  recordedById: ANA,
  updatedById: null,
  recordedBy: { firstName: 'Ana' },
  updatedBy: null,
  ...over,
});

const goal = (over: Partial<GoalRow> = {}): GoalRow => ({
  id: 'g1',
  name: 'Lose weight',
  unit: 'kg',
  startHundredths: 9500,
  currentHundredths: 9000,
  targetHundredths: 8500,
  achievedAt: null,
  recordedById: null,
  updatedById: null,
  recordedBy: null,
  updatedBy: null,
  ...over,
});

/**
 * Who recorded a reading is the one new fact on this screen, and the wire
 * carries it as a FIRST NAME only. No user id reaches a member's phone: the
 * member has no route that takes one, and an id is a handle for nothing but
 * enumeration.
 */
describe('provenance', () => {
  it('names the recording coach, and nothing else about them', () => {
    const dto = toMeasurement(measurementRow());
    expect(dto.recordedBy).toEqual({ firstName: 'Ana' });
    expect(dto.updatedBy).toBeNull();
    expect(JSON.stringify(dto)).not.toContain(ANA);
    expect(dto).not.toHaveProperty('recordedById');
    expect(dto).not.toHaveProperty('updatedById');
  });

  /** NULL is the only spelling of "self-recorded". */
  it('reports a row with no recorder as self-recorded (null)', () => {
    const dto = toMeasurement(measurementRow({ recordedById: null, recordedBy: null }));
    expect(dto.recordedBy).toBeNull();
    expect(dto.updatedBy).toBeNull();
  });

  it('names a DIFFERENT coach who corrected the reading', () => {
    const dto = toMeasurement(
      measurementRow({ updatedById: BEN, updatedBy: { firstName: 'Ben' } }),
    );
    expect(dto.recordedBy).toEqual({ firstName: 'Ana' });
    expect(dto.updatedBy).toEqual({ firstName: 'Ben' });
    expect(JSON.stringify(dto)).not.toContain(BEN);
  });

  /** "Recorded by Coach Ana · updated by Coach Ana" says nothing twice. */
  it('omits the updater when it is the recorder', () => {
    const dto = toMeasurement(
      measurementRow({ updatedById: ANA, updatedBy: { firstName: 'Ana' } }),
    );
    expect(dto.updatedBy).toBeNull();
  });

  it('applies the same rules to goals', () => {
    const coached = toGoal(
      goal({
        recordedById: ANA,
        recordedBy: { firstName: 'Ana' },
        updatedById: BEN,
        updatedBy: { firstName: 'Ben' },
      }),
    );
    expect(coached.recordedBy).toEqual({ firstName: 'Ana' });
    expect(coached.updatedBy).toEqual({ firstName: 'Ben' });
    expect(JSON.stringify(coached)).not.toContain(ANA);

    const self = toGoal(goal());
    expect(self.recordedBy).toBeNull();
    expect(self.updatedBy).toBeNull();
  });
});

describe('goal percent', () => {
  /**
   * THE LOAD-BEARING CASE.
   *
   * 95 kg down to 85 kg, currently 90, is half done. A naive
   * `current / target` calls that 106% — telling a member trying to lose
   * weight that they have overshot while they are exactly halfway.
   */
  it('measures from the start, so a downward goal works', () => {
    expect(toGoal(goal()).percent).toBe(50);
  });

  it('measures an upward goal the same way', () => {
    // Bench 60kg -> 100kg, currently 80.
    expect(
      toGoal(goal({ startHundredths: 6000, currentHundredths: 8000, targetHundredths: 10_000 }))
        .percent,
    ).toBe(50);
  });

  it('clamps to 0-100 rather than reporting 140% or -30%', () => {
    expect(toGoal(goal({ currentHundredths: 8000 })).percent).toBe(100);
    expect(toGoal(goal({ currentHundredths: 9900 })).percent).toBe(0);
  });

  it('is 0 at the start and 100 at the target', () => {
    expect(toGoal(goal({ currentHundredths: 9500 })).percent).toBe(0);
    expect(toGoal(goal({ currentHundredths: 8500 })).percent).toBe(100);
  });
});

describe('summarise', () => {
  it('reports the change between the first and latest weigh-in', () => {
    const result = summarise(
      [weighIn('a', '2026-06-01', 95_000), weighIn('b', '2026-08-26', 90_000)],
      [],
      TODAY,
    );

    expect(result.latestWeightGrams).toBe(90_000);
    expect(result.changeGrams).toBe(-5000);
    expect(result.changeOverDays).toBe(86);
  });

  /**
   * A single weigh-in is not a trend. Reporting "0 kg change" reads as "you
   * have made no progress" rather than "there is nothing to compare yet" —
   * the opposite of true for somebody on day one.
   */
  it('reports no change at all from a single entry', () => {
    const result = summarise([weighIn('a', '2026-08-26', 90_000)], [], TODAY);
    expect(result.latestWeightGrams).toBe(90_000);
    expect(result.changeGrams).toBeNull();
    expect(result.changeOverDays).toBeNull();
  });

  it('has nothing to report with no measurements', () => {
    const result = summarise([], [], TODAY);
    expect(result.latestWeightGrams).toBeNull();
    expect(result.changeGrams).toBeNull();
    expect(result.bmiThousandths).toBeNull();
  });

  /** A height-only row must not become a point on the weight trend. */
  it('ignores entries that carry no weight', () => {
    const heightOnly: MeasurementDto = {
      id: 'h',
      businessDate: '2026-07-01' as CivilDate,
      weightGrams: null,
      heightMm: 1750,
      bodyFatPermille: null,
      notes: null,
      recordedBy: null,
      updatedBy: null,
    };

    const result = summarise([heightOnly, weighIn('a', '2026-08-26', 90_000)], [], TODAY);
    expect(result.changeGrams).toBeNull();
    expect(result.latestWeightGrams).toBe(90_000);
  });

  /**
   * Height is recorded rarely and weight often. Requiring both on the same row
   * would leave BMI null for everyone who ever weighed themselves without
   * re-measuring their height.
   */
  it('takes height from the most recent entry that has one', () => {
    const result = summarise(
      [weighIn('a', '2026-06-01', 95_000, 1750), weighIn('b', '2026-08-26', 90_000)],
      [],
      TODAY,
    );

    // 90 / 1.75^2 = 29.387...
    expect(result.bmiThousandths).toBe(29_388);
  });

  it('has no BMI without a height anywhere', () => {
    const result = summarise([weighIn('a', '2026-08-26', 90_000)], [], TODAY);
    expect(result.bmiThousandths).toBeNull();
  });

  // Owner, 2026-10-20: the MEMBER is the source of truth for height and
  // weight. Their account values are the "current" numbers everybody already
  // shown this summary sees; measurements stay the history (and the trend).
  describe("with the member's own account values", () => {
    const history = [weighIn('a', '2026-06-01', 95_000, 1750), weighIn('b', '2026-08-26', 90_000)];

    it('shows the account weight as the current weight, the trend unchanged', () => {
      const result = summarise(history, [], TODAY, null, { weightKg: 80.5, heightCm: null });
      expect(result.latestWeightGrams).toBe(80_500);
      expect(result.changeGrams).toBe(-5000);
      expect(result.changeOverDays).toBe(86);
    });

    it('works BMI out from the account weight and a measured height', () => {
      const result = summarise(history, [], TODAY, null, { weightKg: 80, heightCm: null });
      // 80 / 1.75^2 = 26.122...
      expect(result.bmiThousandths).toBe(26_122);
    });

    it('works BMI out from a measured weight and the account height', () => {
      const result = summarise(history, [], TODAY, null, { weightKg: null, heightCm: 180 });
      expect(result.latestWeightGrams).toBe(90_000);
      // 90 / 1.80^2 = 27.777...
      expect(result.bmiThousandths).toBe(27_778);
    });

    it('needs no measurement at all when the account has both', () => {
      const result = summarise([], [], TODAY, null, { weightKg: 72.4, heightCm: 170 });
      expect(result.latestWeightGrams).toBe(72_400);
      expect(result.changeGrams).toBeNull();
      // 72.4 / 1.70^2 = 25.051...
      expect(result.bmiThousandths).toBe(25_052);
    });

    it('falls back to the measurements when the account has neither', () => {
      const result = summarise(history, [], TODAY, null, { weightKg: null, heightCm: null });
      expect(result.latestWeightGrams).toBe(90_000);
      expect(result.bmiThousandths).toBe(29_388);
    });
  });

  it('carries the assigned coach by name, or null when the member has none', () => {
    expect(summarise([], [], TODAY).coach).toBeNull();
    expect(summarise([], [], TODAY, { firstName: 'Ana', lastName: 'Reyes' }).coach).toEqual({
      firstName: 'Ana',
      lastName: 'Reyes',
    });
  });
});
