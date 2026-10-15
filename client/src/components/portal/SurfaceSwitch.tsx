import Link from 'next/link';
import { MEMBER_HOME, STAFF_HOME } from '@/lib/safeNext';
import { IconArrow } from './icons';

/**
 * The one control that crosses between the member portal and the staff console.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A COMPONENT AND NOT TWO LINKS.
 *
 * It replaces a gold-tinted `<Link>` wedged between an 18px spacer and Sign
 * out at the bottom of the member sidebar — with NO counterpart on the console
 * side. That asymmetry is most of why the two surfaces read as one product
 * with a bug rather than two surfaces with a door: staff could fall into the
 * portal and climb out, but could not deliberately go there.
 *
 * One component, rendered in the same topbar slot on both shells, so the pair
 * can never drift into two hand-patched affordances again.
 *
 * The LABEL IS NOT OPTIONAL. A bare arrow in a chrome slot reads as "next" or
 * "forward"; a label with a trailing arrow reads as "go there". It also names
 * the destination rather than the current surface, which is the half users
 * actually need — where they are is already the loudest thing on screen.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Rendered only for staff. A member never sees it, so the 95% who hold one
 * surface pay nothing for the 5% who hold two.
 */
export function SurfaceSwitch({ to }: { to: 'portal' | 'admin' }) {
  const target = to === 'admin' ? STAFF_HOME : MEMBER_HOME;
  const label = to === 'admin' ? 'Staff console' : 'Member portal';

  return (
    <Link
      href={target}
      className="p-surface-switch"
      // Named for a screen reader, because the visible label says where it
      // goes but not that following it changes surface.
      aria-label={`Switch to the ${label.toLowerCase()}`}
    >
      <span>{label}</span>
      <IconArrow size={14} />
    </Link>
  );
}
