import { WORKOUT_LIMITS } from '@got/shared';
import { IconWarning } from '../icons';
import { Button, Notice } from '../ui';

/**
 * Draft mode's "Save to my plans": the name (prefilled from goal + level),
 * "Make it my active plan", and the gold button. Inline in the header on
 * desktop; a sticky bar above the tab bar on phones.
 */
export function SaveBar({
  name,
  makeActive,
  busy,
  error,
  onName,
  onMakeActive,
  onSave,
}: {
  name: string;
  makeActive: boolean;
  busy: boolean;
  error: React.ReactNode | null;
  onName: (value: string) => void;
  onMakeActive: (value: boolean) => void;
  onSave: () => void;
}) {
  const trimmed = name.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= WORKOUT_LIMITS.planNameMax;
  return (
    <form
      className="flex flex-col gap-2.5 border-t border-[rgba(26,26,26,0.08)] bg-card px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom,0px))] max-[900px]:sticky max-[900px]:bottom-[58px] max-[900px]:z-30 max-[900px]:-mx-4 max-[900px]:shadow-[0_-8px_24px_rgba(26,26,26,0.06)] @3xl:mx-0 @3xl:border-0 @3xl:bg-transparent @3xl:p-0 @3xl:shadow-none"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !busy) onSave();
      }}
    >
      {error === null ? null : (
        <Notice tone="warn" role="alert" icon={<IconWarning />}>
          {error}
        </Notice>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 @3xl:flex @3xl:justify-end">
        <label className="sr-only" htmlFor="wk-plan-name">
          Plan name
        </label>
        <input
          id="wk-plan-name"
          type="text"
          value={name}
          maxLength={WORKOUT_LIMITS.planNameMax}
          onChange={(e) => onName(e.target.value)}
          placeholder="Name this plan"
          className="h-11 min-w-0 rounded-[10px] border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3.5 text-[14px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold @3xl:w-[220px]"
        />
        <Button variant="gold" size="sm" type="submit" disabled={!valid || busy} className="px-5">
          {busy ? 'Saving…' : 'Save to my plans'}
        </Button>
      </div>
      <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[color:var(--p-ink)] @3xl:justify-end">
        <input
          type="checkbox"
          checked={makeActive}
          onChange={(e) => onMakeActive(e.target.checked)}
          className="h-[18px] w-[18px] accent-[var(--gold)]"
        />
        Make it my active plan
      </label>
    </form>
  );
}
