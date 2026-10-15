/**
 * Member progress on the wire — mirrors `server/src/me/progress.presenter.ts`.
 *
 * EVERY VALUE IS AN INTEGER: grams, millimetres, per mille, hundredths. The
 * client divides and formats (`progressView.ts`), the same division of labour
 * money follows with centavos.
 *
 * `recordedBy`, `updatedBy` and `coach` are OPTIONAL in the type on purpose.
 * They arrived with coach-recorded progress, and a browser holding this bundle
 * can meet an API that predates them for the length of a deploy. Absent means
 * "the server did not say", which is different from `null` ("self-recorded" /
 * "no coach") — and `progressView` keeps the two apart rather than rendering a
 * label the data does not support.
 */

/** The coach, as far as a member's screen needs them. Never an id. */
export interface ProgressPerson {
  firstName: string;
}

export interface Provenance {
  /** Null: the member recorded it themselves, before coaches did. */
  recordedBy?: ProgressPerson | null;
  /** Set only when a different coach corrected it afterwards. */
  updatedBy?: ProgressPerson | null;
}

export interface Measurement extends Provenance {
  id: string;
  /** `yyyy-mm-dd`, the gym's civil day. */
  businessDate: string;
  weightGrams: number | null;
  heightMm: number | null;
  bodyFatPermille: number | null;
  notes: string | null;
}

export interface Goal extends Provenance {
  id: string;
  name: string;
  unit: string;
  startHundredths: number;
  currentHundredths: number;
  targetHundredths: number;
  /** 0-100, computed server-side so every surface shows the same ring. */
  percent: number;
  achievedAt: string | null;
}

export interface ProgressCoach {
  firstName: string;
  lastName: string;
}

export interface ProgressSummary {
  measurements: Measurement[];
  goals: Goal[];
  latestWeightGrams: number | null;
  changeGrams: number | null;
  changeOverDays: number | null;
  bmiThousandths: number | null;
  /** Null: no active coach. Absent: a server from before coaches recorded. */
  coach?: ProgressCoach | null;
}

/** The coach's drill-down: the member card, then the summary the member sees. */
export interface CoachMemberProgress extends ProgressSummary {
  member: {
    id: string;
    firstName: string;
    lastName: string;
    memberCode: string | null;
  };
}

/** POST body — integers only. Omitted fields are "not given", never "clear". */
export interface MeasurementBody {
  businessDate?: string;
  weightGrams?: number;
  heightMm?: number;
  bodyFatPermille?: number;
  notes?: string;
}

/** PATCH body — an explicit null CLEARS the field. */
export interface MeasurementPatch {
  weightGrams?: number | null;
  heightMm?: number | null;
  bodyFatPermille?: number | null;
  notes?: string | null;
}

export interface GoalBody {
  name: string;
  unit: string;
  startHundredths: number;
  targetHundredths: number;
}

export interface GoalPatch {
  name?: string;
  currentHundredths?: number;
  targetHundredths?: number;
  achieved?: boolean;
}
