import Link from 'next/link';
import type { MemberWorkoutPlanView, WorkoutIntakeSummary } from '@got/shared';
import { planChips, writtenLine } from '@/lib/workouts/planView';
import { IconPencil, IconSparkle } from '../icons';
import { Button, Chip, Panel, Tag, buttonClass } from '../ui';
import { useMemberCanWrite } from '@/components/portal/MembershipGate';

/**
 * The plan's title card: name, DRAFT / SAVED badge, intake chips, the
 * "Written by AI on …" line, and Regenerate · Edit by hand · Save.
 */
export function PlanHeader({
  name,
  intake,
  meta,
  isActive,
  mode,
  editing,
  busy,
  regenerateHref,
  onEdit,
  save,
}: {
  name: string;
  intake: WorkoutIntakeSummary;
  meta: Pick<MemberWorkoutPlanView, 'source' | 'createdAt' | 'updatedAt'> | null;
  isActive: boolean;
  mode: 'draft' | 'saved';
  editing: boolean;
  busy: boolean;
  regenerateHref: string;
  onEdit: () => void;
  /** Draft mode's inline save form, rendered on the right on desktop. */
  save?: React.ReactNode;
}) {
  // A lapsed member reads the plan; Regenerate and Edit by hand are writes.
  const canWrite = useMemberCanWrite();
  return (
    <Panel
      aria-labelledby="wk-plan-h"
      className="flex flex-col gap-4 px-4 py-4 @3xl:flex-row @3xl:items-start @3xl:justify-between @3xl:gap-6 @3xl:px-7 @3xl:py-6"
    >
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-3">
          <h2
            id="wk-plan-h"
            className="m-0 font-display text-[26px] leading-[1.1] font-extrabold tracking-[-0.01em] @3xl:text-[32px]"
          >
            {name}
          </h2>
          {mode === 'draft' ? (
            <Tag tone="warn">Draft · Not saved</Tag>
          ) : isActive ? (
            <Tag tone="ok">Saved · Active plan</Tag>
          ) : (
            <Tag tone="ok">Saved</Tag>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {planChips(intake).map((chip) => (
            <Chip key={chip.label} tone={chip.tone}>
              {chip.label}
            </Chip>
          ))}
        </div>
        <p className="m-0 text-[13px] text-ink-3">
          {meta === null
            ? 'Written by AI just now — check with a coach or the front desk if anything feels off.'
            : writtenLine(meta)}
        </p>
      </div>

      <div className="flex shrink-0 flex-col gap-2.5 @3xl:items-end">
        {canWrite ? (
          <div className="grid grid-cols-2 gap-2 @3xl:flex @3xl:gap-2.5">
            <Link href={regenerateHref} className={buttonClass('ghost', 'sm', 'text-[13px]')}>
              <IconSparkle size={16} />
              Regenerate
            </Link>
            {mode === 'saved' ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-[13px]"
                disabled={busy || editing}
                onClick={onEdit}
              >
                <IconPencil />
                Edit by hand
              </Button>
            ) : null}
          </div>
        ) : null}
        {save === undefined ? null : <div className="hidden @3xl:block">{save}</div>}
      </div>
    </Panel>
  );
}
