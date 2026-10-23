import { useState } from 'react';
import { WORKOUT_ADJUST_PRESETS, WORKOUT_LIMITS, type WorkoutAdjustPreset } from '@got/shared';
import { PRESET_LABEL } from '@/lib/workouts/labels';
import { IconSend, IconSparkle, IconSpinner } from '../icons';
import { ToggleChip } from '../ui';

/**
 * "Adjust this day with AI": five preset chips and a free-text line. A chip
 * sends at once (the mockup's behaviour); the text sends on Enter or the
 * arrow. `aria-pressed` marks the chip whose result is on screen.
 */
export function AdjustBar({
  weekday,
  activePreset,
  busy,
  disabled,
  onPreset,
  onRequest,
}: {
  weekday: number;
  activePreset: WorkoutAdjustPreset | null;
  busy: boolean;
  /** No AI actions left: the controls stay visible, greyed, with the reason. */
  disabled: string | null;
  onPreset: (preset: WorkoutAdjustPreset) => void;
  onRequest: (request: string) => void;
}) {
  const [text, setText] = useState('');
  const inputId = `wk-adjust-${weekday}`;
  const blocked = busy || disabled !== null;
  const canSend = !blocked && text.trim().length > 0;

  const send = (): void => {
    const request = text.trim().slice(0, WORKOUT_LIMITS.adjustRequestMax);
    if (request === '' || blocked) return;
    onRequest(request);
    setText('');
  };

  return (
    <div className="flex flex-col gap-2.5 bg-[#fbfaf8] px-4 py-4 @2xl:px-[22px]">
      <span className="inline-flex flex-wrap items-center gap-2 text-[13.5px] font-semibold text-[color:var(--p-ink)]">
        {busy ? (
          <IconSpinner size={16} className="text-gold-deep motion-safe:animate-spin" />
        ) : (
          <IconSparkle size={16} className="text-gold-deep" />
        )}
        {busy ? 'Adjusting this day…' : 'Adjust this day with AI'}
        <span className="font-normal text-ink-3">· 1 AI action</span>
      </span>
      {disabled === null ? null : <span className="text-[12.5px] text-ink-3">{disabled}</span>}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Quick adjustments">
        {WORKOUT_ADJUST_PRESETS.map((preset) => (
          <ToggleChip
            key={preset}
            pressed={activePreset === preset}
            disabled={blocked}
            onClick={() => onPreset(preset)}
            className="h-[38px] px-3.5 text-[13px] pointer-coarse:h-11 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {PRESET_LABEL[preset]}
          </ToggleChip>
        ))}
      </div>
      <div className="flex gap-2">
        <label htmlFor={inputId} className="sr-only">
          Tell the AI what to change
        </label>
        <input
          id={inputId}
          type="text"
          value={text}
          maxLength={WORKOUT_LIMITS.adjustRequestMax}
          disabled={blocked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Or tell it what to change — e.g. “the squat rack is always taken at 6 PM”"
          className="h-11 min-w-0 grow rounded-[10px] border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3.5 text-[14px] text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:opacity-60"
        />
        <button
          type="button"
          aria-label="Send to the AI"
          disabled={!canSend}
          onClick={send}
          className="flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-[10px] bg-night text-gold-lit focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-50"
        >
          <IconSend />
        </button>
      </div>
    </div>
  );
}
