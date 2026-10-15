import type { WorkoutPlanBody } from '@got/shared';

/**
 * A saved workout plan, read-only — the coach's view and the member's
 * "My workout plan" card render the same thing, so they cannot disagree.
 *
 * Plain text throughout; portal classes and inline styles only (this folder
 * is not a Tailwind @source).
 */
export function PlanDays({ plan }: { plan: WorkoutPlanBody }) {
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
        {plan.summary}
      </p>
      <div
        style={{
          display: 'grid',
          gap: 12,
          gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        }}
      >
        {plan.days.map((day, index) => (
          <section key={`${index}-${day.day}`} className="p-plan-day">
            <div>
              <div className="p-card-title">{day.day}</div>
              <div className="p-muted" style={{ fontSize: 12.5 }}>
                {day.focus}
              </div>
            </div>
            <ol className="p-plan-list">
              {day.exercises.map((exercise, i) => (
                <li key={`${i}-${exercise.name}`}>
                  <strong style={{ fontWeight: 600 }}>{exercise.name}</strong>
                  <span className="p-muted">
                    {exercise.sets} × {exercise.reps}
                  </span>
                  {exercise.notes === undefined ? null : (
                    <span className="p-muted" style={{ flexBasis: '100%', fontSize: 12.5 }}>
                      {exercise.notes}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </section>
        ))}
      </div>
    </div>
  );
}
