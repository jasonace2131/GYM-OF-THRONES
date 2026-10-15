import type { PlanGuidance } from '@got/shared';
import { IconDrop, IconFork, IconHeart, IconMoon } from './icons';
import { KickerHeading, Panel } from './ui';

/** Picks the glyph and tint for a guidance title — the mockup's four. */
export function guidanceGlyph(title: string): { icon: React.ReactNode; className: string } {
  const t = title.toLowerCase();
  if (t.includes('sleep')) return { icon: <IconMoon />, className: 'bg-info-bg text-info' };
  if (t.includes('protein') || t.includes('food') || t.includes('eat'))
    return { icon: <IconFork />, className: 'bg-warn-bg text-warn' };
  if (t.includes('water') || t.includes('hydrat') || t.includes('drink'))
    return { icon: <IconDrop />, className: 'bg-ok-bg text-ok' };
  return { icon: <IconHeart />, className: 'bg-paper-3 text-[color:var(--p-ink)]' };
}

/** TODAY'S WELLNESS TIP on the hub. */
export function TipCard({ tip }: { tip: PlanGuidance }) {
  const glyph = guidanceGlyph(tip.title);
  return (
    <Panel
      aria-labelledby="wk-tip-h"
      className="flex flex-col gap-3 px-4 py-4 @md:px-[22px] @md:py-5"
    >
      <KickerHeading id="wk-tip-h">Today&apos;s wellness tip</KickerHeading>
      <div className="flex items-start gap-3">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${glyph.className}`}
          aria-hidden
        >
          {glyph.icon}
        </span>
        <p className="m-0 text-[14px] leading-[1.5] text-[color:var(--p-ink)]">
          <strong className="font-semibold">{tip.title}.</strong> {tip.body}
        </p>
      </div>
      <p className="m-0 text-[11.5px] text-ink-3">General guidance, not medical advice.</p>
    </Panel>
  );
}
