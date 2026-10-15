import '../desk.css';

/**
 * The desk surfaces: the station display and (later) the staff console.
 *
 * Deliberately NOT under the portal layout. The portal is a signed-in member's
 * application shell with a sidebar, a topbar and an auth redirect; the station
 * display is a mounted panel that has no user, no session and no navigation,
 * and must never bounce to `/login` because a member's session expired in
 * another tab of a browser it does not share.
 */
export default function DeskLayout({ children }: { children: React.ReactNode }) {
  return <div className="desk-root">{children}</div>;
}
