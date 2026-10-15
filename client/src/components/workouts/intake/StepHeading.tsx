import { Notice } from '../ui';
import { IconWarning } from '../icons';

export function StepHeading({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h2 id="wk-step-h" className="m-0 font-display text-[24px] font-bold @2xl:text-[26px]">
        {title}
      </h2>
      <p className="m-0 text-[14px] leading-[1.5] text-ink-2 @2xl:text-[14.5px]">{sub}</p>
    </div>
  );
}

/** What is missing, shown only after the member tried to move on. */
export function StepProblem({ problem }: { problem: string | null }) {
  if (problem === null) return null;
  return (
    <Notice tone="warn" role="alert" icon={<IconWarning />}>
      {problem}
    </Notice>
  );
}
