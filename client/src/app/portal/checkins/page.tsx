'use client';

import { useEffect, useState } from 'react';
import { getCheckInHistory, type CheckInHistoryData } from '@/lib/portalData';
import { Badge, Card, CardHead, EmptyState, Skeleton, Stat } from '@/components/portal/ui';
import { ConsistencyHeatmap } from '@/components/portal/ConsistencyHeatmap';

const PAGE = 12;

export default function CheckInsPage() {
  const [data, setData] = useState<CheckInHistoryData | null>(null);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    void getCheckInHistory().then(setData);
  }, []);

  if (!data) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={92} />
        <Skeleton height={170} />
        <Skeleton height={320} />
      </div>
    );
  }

  const visible = data.records.slice(0, shown);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
          gap: 14,
        }}
      >
        <Stat value={data.checkInsThisMonth} label="This month" />
        <Stat value={data.checkInsAllTime} label="All-time visits" />
        <Stat value={`${data.avgPerWeek}/wk`} label="Average frequency" />
        <Stat value={`${data.longestStreakWeeks}w`} label="Longest streak" accent />
      </div>

      <Card padded={false}>
        <CardHead title="Consistency" />
        <div className="p-card-pad">
          <ConsistencyHeatmap days={data.heatmap} />
        </div>
      </Card>

      <Card padded={false}>
        <CardHead
          title="Full history"
          action={
            <span style={{ fontSize: 12, color: 'var(--p-ink3)' }}>
              {/* The API caps a page at 100, so for a long-standing member the
                  table is the most recent slice rather than the whole history.
                  Saying so is the difference between a truncated table and a
                  wrong visit count. */}
              {data.records.length < data.recordsTotal
                ? `${data.records.length} most recent of ${data.recordsTotal}`
                : `${data.recordsTotal} visits`}
            </span>
          }
        />

        {data.records.length === 0 ? (
          <EmptyState title="No visits recorded yet" hint="Your check-ins will appear here." />
        ) : (
          <>
            <div style={{ overflowX: 'auto' }}>
              <table className="p-table" data-stack>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>Time in</th>
                    <th>Time out</th>
                    <th>Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => (
                    <tr key={r.id}>
                      <td
                        data-label="Date"
                        style={{ whiteSpace: 'nowrap', color: 'var(--p-ink)', fontWeight: 500 }}
                      >
                        {r.date}
                      </td>
                      <td data-label="Day">{r.day}</td>
                      <td data-label="In" className="p-num">
                        {r.timeIn}
                      </td>
                      <td data-label="Out" className="p-num">
                        {r.timeOut ?? '—'}
                      </td>
                      <td data-label="Duration" className="p-num">
                        {r.duration}
                      </td>
                      <td data-label="Status">
                        <Badge tone={r.status === 'active' ? 'warn' : 'ok'}>{r.status}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {shown < data.records.length && (
              <div style={{ padding: 16, textAlign: 'center' }}>
                <button
                  type="button"
                  className="p-btn p-btn-ghost p-btn-sm"
                  onClick={() => setShown((s) => s + PAGE)}
                >
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
