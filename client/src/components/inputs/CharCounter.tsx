import type { CSSProperties } from 'react';

/**
 * "120/500" under a long text field, so the limit is visible before it bites.
 *
 * Give it an `id` and put that id in the field's `aria-describedby`, so a
 * screen reader reads the count with the field. It is announced (polite live
 * region) only in the last tenth before the limit — announcing every keystroke
 * would drown out the typing. Full-opacity text at 12.5px for contrast; the
 * danger colour marks the last tenth.
 */
export function CharCounter({
  value,
  max,
  style,
  id,
}: {
  value: string;
  max: number;
  style?: CSSProperties;
  id?: string;
}) {
  const used = value.length;
  const near = used >= Math.floor(max * 0.9);
  return (
    <span
      id={id}
      aria-live={near ? 'polite' : 'off'}
      style={{
        display: 'block',
        textAlign: 'right',
        fontSize: 12.5,
        color: near ? 'var(--p-danger, #b3261e)' : 'inherit',
        ...style,
      }}
    >
      {used}/{max}
      <span style={VISUALLY_HIDDEN}> characters</span>
    </span>
  );
}

const VISUALLY_HIDDEN: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
};
