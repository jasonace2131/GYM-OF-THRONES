'use client';

import { useMemo } from 'react';
import { QR_SIZE, encodeStationQr, qrPath } from '@/lib/qr';

interface StationQrProps {
  payload: string;
  /**
   * Modules of white around the symbol. FOUR is the standard minimum and is
   * not a style choice — a decoder locates the finder patterns by their
   * light surround, and a thinner quiet zone is a symbol that reads on a desk
   * and fails in a lobby.
   */
  quietModules?: number;
  /** Rendered edge of the symbol including its quiet zone, in CSS pixels. */
  targetPx: number;
}

/**
 * The rotating station symbol.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE MODULE SIZE IS COMPUTED, THE SYMBOL SIZE IS DERIVED — never the other
 * way round.
 *
 * `Math.floor(targetPx / modules)` gives an INTEGER CSS pixel per module, and
 * the SVG is then sized to exactly `modulePx × modules`. Scaling a fixed
 * canvas to fit a box instead lands module edges on half device pixels, and a
 * half-pixel edge is the single most common cause of a screen QR that
 * "sometimes" reads — the worst possible failure, because it works whenever
 * anyone tests it.
 *
 * Floor to at least 12 px per module: 25 × 12 = 300 px ≈ 79 mm of symbol on a
 * 10" panel. The rule of thumb for an emissive screen read through glare is
 * roughly `scan distance ÷ 5`, so 40 cm wants ~80 mm. If the container cannot
 * give that, the symbol overflows deliberately rather than shrinking below
 * what a phone can read.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * `#000` on `#FFF`, in every state, with no exceptions. Brand lives in the
 * wordmark 40 mm away.
 */
export function StationQr({ payload, quietModules = 4, targetPx }: StationQrProps) {
  const modules = QR_SIZE + quietModules * 2;

  const path = useMemo(() => qrPath(encodeStationQr(payload)), [payload]);

  const modulePx = Math.max(MIN_MODULE_PX, Math.floor(targetPx / modules));
  const sizePx = modulePx * modules;

  return (
    <svg
      // Keyed on the payload so React swaps the whole node on a slot
      // boundary, which is what the 180 ms crossfade animates.
      key={payload}
      className="st-swap"
      width={sizePx}
      height={sizePx}
      viewBox={`0 0 ${modules} ${modules}`}
      role="img"
      // A member never reads this; a staff member with a screen reader
      // walking the floor should not hear a 36-character token.
      aria-label="Check-in code"
    >
      <rect width={modules} height={modules} fill="#fff" />
      <g transform={`translate(${quietModules} ${quietModules})`}>
        <path d={path} fill="#000" />
      </g>
    </svg>
  );
}

/**
 * The floor, in CSS pixels. Below this the symbol is not reliably readable by
 * a mid-range phone at arm's length through screen glare, so the component
 * overflows its container rather than rendering something that looks fine and
 * scans badly.
 */
const MIN_MODULE_PX = 12;
