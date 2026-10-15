'use client';

import { useEffect, useState } from 'react';
import { PERMISSIONS } from '@got/shared';
import { RequirePermission } from '@/components/rbac/guards';
import { apiFetch } from '@/lib/api';
import {
  formatBmi,
  formatChangeKg,
  formatKg,
  pageMode,
  type PageMode,
} from '@/lib/progress/progressView';
import type { ProgressSummary } from '@/lib/progress/types';
import { Card, CardHead, EmptyState, Skeleton, Stat } from '@/components/portal/ui';
import { WeightChart } from '@/components/portal/progress/WeightChart';
import { GoalRow } from '@/components/portal/progress/GoalRow';
import { MeasurementHistory } from '@/components/portal/progress/MeasurementHistory';
import { CoachingExplainer } from '@/components/portal/progress/CoachingExplainer';

/**
 * The member's own progress: body measurements and goals. READ-ONLY.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MEMBER NO LONGER RECORDS ANYTHING HERE (owner decision, 2026-09).
 *
 * Their assigned coach records measurements and sets goals at their sessions,
 * from the coach's drill-down (`/portal/coaching/members/[memberId]`). This
 * page shows what was recorded and by whom. Three shapes:
 *
 *   - coached   — a line naming the coach, then the tiles, chart and history.
 *   - uncoached — the coaching explainer first; anything the member recorded
 *                 themselves before the change stays below it, labelled.
 *   - unknown   — an API from before coaches recorded: the page as it was,
 *                 minus the write controls, with no labels and no explainer.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * THE WORKOUT LOG THE MOCK SHOWED IS DELIBERATELY NOT HERE. A sets-and-reps
 * journal is a training-log product rather than a gym CRM. Cut and named
 * rather than stubbed with fabricated rows.
 */
/**
 * A member's own section: `progress.self`, which only CLIENT holds. A coach
 * records other people's progress on the coach dashboard and has no progress
 * of their own here (owner decision, 2026-09-25).
 */
export default function ProgressPage() {
  return (
    <RequirePermission permission={PERMISSIONS.PROGRESS_SELF}>
      <Progress />
    </RequirePermission>
  );
}

function Progress() {
  const [data, setData] = useState<ProgressSummary | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void apiFetch<ProgressSummary>('/me/progress')
      .then((summary) => {
        if (!cancelled) setData(summary);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (failed) {
    return (
      <Card>
        <EmptyState
          title="Could not load your progress"
          hint="Check your connection and refresh."
        />
      </Card>
    );
  }

  if (data === null) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={90} />
        <Skeleton height={200} />
        <Skeleton height={180} />
      </div>
    );
  }

  const mode = pageMode(data);
  const weighed = data.measurements.filter((m) => m.weightGrams !== null);
  const hasHistory = data.measurements.length > 0 || data.goals.length > 0;
  const labelled = mode !== 'unknown';

  return (
    <div style={{ display: 'grid', gap: 20 }} className="p-rise">
      {mode === 'coached' && data.coach ? (
        <div
          role="note"
          style={{
            padding: '12px 16px',
            borderRadius: 'var(--p-radius)',
            border: '1px solid var(--p-border)',
            background: 'var(--p-paper)',
            borderLeft: '3px solid var(--gold)',
            fontSize: 14,
            color: 'var(--p-ink2)',
          }}
        >
          <strong style={{ color: 'var(--p-ink)' }}>Coach {data.coach.firstName}</strong> records
          your measurements and goals at your sessions.
        </div>
      ) : null}

      {mode === 'uncoached' ? <CoachingExplainer hasHistory={hasHistory} /> : null}

      {mode === 'uncoached' && !hasHistory ? null : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
              gap: 14,
            }}
          >
            <Stat
              value={
                data.latestWeightGrams === null ? '—' : `${formatKg(data.latestWeightGrams)}kg`
              }
              label="Current weight"
            />
            <Stat
              // Null means "nothing to compare yet", which is not the same as no
              // progress — showing 0kg to somebody on day one would be a lie.
              value={data.changeGrams === null ? '—' : `${formatChangeKg(data.changeGrams)}kg`}
              label={data.changeOverDays === null ? 'Change' : `Over ${data.changeOverDays} days`}
              accent
            />
            <Stat
              value={data.bmiThousandths === null ? '—' : formatBmi(data.bmiThousandths)}
              label="BMI"
            />
            <Stat
              value={data.goals.filter((g) => g.achievedAt === null).length}
              label="Active goals"
            />
          </div>

          <Card padded={false}>
            <div style={{ padding: '18px 18px 0' }}>
              <CardHead title="Weight" />
            </div>
            <div className="p-card-pad">
              {weighed.length < 2 ? (
                <p style={{ margin: 0, color: 'var(--p-ink3)', fontSize: 13.5 }}>
                  {weightChartHint(mode, weighed.length)}
                </p>
              ) : (
                <WeightChart points={weighed} />
              )}
            </div>
          </Card>

          <Card padded={false}>
            <div style={{ padding: '18px 18px 0' }}>
              <CardHead title="Goals" />
            </div>
            {data.goals.length === 0 ? (
              <EmptyState title="No goals yet" hint={goalsHint(mode)} />
            ) : (
              <div className="p-card-pad" style={{ display: 'grid', gap: 16 }}>
                {data.goals.map((goal) => (
                  <GoalRow key={goal.id} goal={goal} showProvenance={labelled} />
                ))}
              </div>
            )}
          </Card>

          {data.measurements.length === 0 ? null : (
            <Card padded={false}>
              <div style={{ padding: '18px 18px 0' }}>
                <CardHead title="History" />
              </div>
              <div style={{ padding: '0 18px 6px' }}>
                <MeasurementHistory entries={data.measurements} showProvenance={labelled} />
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

function weightChartHint(mode: PageMode, weighed: number): string {
  if (weighed === 1) return 'One more weigh-in and a trend line appears here.';
  return mode === 'coached'
    ? 'Your coach records your weight at your sessions. It will show here.'
    : 'No weigh-ins recorded yet.';
}

function goalsHint(mode: PageMode): string {
  return mode === 'coached'
    ? 'Your coach sets goals with you — lose 5kg, bench 100kg, come 12 times a month.'
    : 'Goals are set with your coach.';
}
