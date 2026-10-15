import { SAFETY_LINE } from '@/lib/workouts/labels';
import { IconShield } from './icons';

/** The line every planner screen ends with. */
export function SafetyLine() {
  return (
    <p className="m-0 flex items-start gap-2 text-[12.5px] leading-[1.45] text-ink-3">
      <span className="mt-px shrink-0" aria-hidden>
        <IconShield />
      </span>
      {SAFETY_LINE}
    </p>
  );
}
