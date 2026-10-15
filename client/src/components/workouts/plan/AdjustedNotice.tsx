import { IconSparkle } from '../icons';
import { PlainButton } from '../ui';

/** The green "Adjusted:" bar with Keep (PUT) and Undo (local revert). */
export function AdjustedNotice({
  summary,
  busy,
  onKeep,
  onUndo,
}: {
  summary: string;
  busy: boolean;
  onKeep: () => void;
  onUndo: () => void;
}) {
  return (
    <div
      role="status"
      className="mx-4 mt-3 mb-0.5 flex flex-wrap items-center gap-3 rounded-[10px] bg-ok-bg px-3.5 py-3 text-[13.5px] leading-[1.45] text-[#1a4d2e] @2xl:mx-[22px]"
    >
      <IconSparkle size={18} className="shrink-0" />
      <span className="min-w-0 grow basis-[200px]">
        <strong>Adjusted:</strong> {summary}
      </span>
      <span className="flex gap-2">
        <PlainButton tone="ok" disabled={busy} onClick={onKeep}>
          {busy ? 'Keeping…' : 'Keep'}
        </PlainButton>
        <PlainButton tone="okGhost" disabled={busy} onClick={onUndo}>
          Undo
        </PlainButton>
      </span>
    </div>
  );
}
