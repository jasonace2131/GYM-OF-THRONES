import type { StatTile } from '@/lib/dashboard/dashboardView';

/**
 * Four numbers, two by two on a phone and in a row when there is room — never
 * the three-and-one orphan `auto-fit` produced at in-between widths.
 *
 * A `<dl>`: each value is a definition of its label, which is exactly what a
 * screen reader should hear ("Check-ins this month, 3").
 */
export function StatsRow({ tiles }: { tiles: StatTile[] }) {
  return (
    <dl className="m-0 grid grid-cols-2 gap-3 @2xl:grid-cols-4 @2xl:gap-3.5">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className="p-card flex flex-col-reverse justify-end px-4 py-4 @2xl:px-5"
        >
          <dt className="p-stat-label mt-2">{tile.label}</dt>
          <dd className="p-stat-val m-0">{tile.value}</dd>
        </div>
      ))}
    </dl>
  );
}
