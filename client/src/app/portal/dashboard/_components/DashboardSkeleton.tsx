/**
 * The dashboard's shape before its data — the same grid as the real page, so
 * nothing jumps when it lands. Also the `<Suspense>` fallback while the
 * search params resolve, which is why it holds no hooks.
 */
export function DashboardSkeleton() {
  const block = 'animate-pulse rounded-[var(--p-radius)] bg-[#efedea]';
  return (
    <div aria-busy="true" aria-label="Loading your dashboard" className="@container">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <div className={`${block} h-[228px] @xl:h-[212px]`} />
        <div className="grid grid-cols-2 gap-3 @2xl:grid-cols-4 @2xl:gap-3.5">
          {[0, 1, 2, 3].map((tile) => (
            <div key={tile} className={`${block} h-[92px]`} />
          ))}
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)] gap-5 @3xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="grid content-start gap-5">
            <div className={`${block} h-[210px]`} />
            <div className={`${block} h-[230px]`} />
          </div>
          <div className={`${block} h-[420px]`} />
        </div>
      </div>
    </div>
  );
}
