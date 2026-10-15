'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { PERMISSIONS } from '@got/shared';
import { ApiError } from '@/lib/api';
import { coachApi } from '@/lib/coachApi';
import { gymParts } from '@/lib/schedule/gymClock';
import { formatCivilDate } from '@/lib/gymTime';
import { formatBmi, formatChangeKg, formatKg } from '@/lib/progress/progressView';
import type { CoachMemberProgress, Measurement } from '@/lib/progress/types';
import { Badge, Card, CardHead, EmptyState, Skeleton, Stat } from '@/components/portal/ui';
import { WeightChart } from '@/components/portal/progress/WeightChart';
import { GoalRow } from '@/components/portal/progress/GoalRow';
import { GoalForm } from '@/components/portal/progress/GoalForm';
import { MeasurementHistory } from '@/components/portal/progress/MeasurementHistory';
import { MeasurementEditForm, MeasurementForm } from '@/components/portal/progress/MeasurementForm';
import { ConfirmDelete } from '@/components/portal/progress/ConfirmDelete';
import { usePermission } from '@/components/rbac/MeProvider';
import { useChat } from '@/components/chat/RealtimeProvider';
import { messagesBadge } from '@/lib/chat/badge';
import { WorkoutPlanTab } from './_components/WorkoutPlanTab';
import { ChatTab } from './_components/ChatTab';

/**
 * One assigned client: Progress · Workout plan · Chat (feat/coach-tools).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FIRST DYNAMIC ROUTE IN THE CLIENT.
 *
 * A client page, so the id comes from `useParams()` (Next 16: `params` on a
 * page is a Promise; the hook reads the same segment without one). It is
 * UNTRUSTED — typed into an address bar as easily as clicked — and nothing
 * here treats it as proof of anything: the server scopes every route to an
 * ACTIVE assignment to the caller and answers everything else with one 404.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The page loads the member's progress once — it is both the Progress tab and
 * the header — and gates the whole page on its answer. The tab is kept in the
 * URL hash (`#progress`, `#plan`, `#chat`), read in an effect, so the My
 * Clients hub can link straight to a tab and this client page needs no
 * Suspense boundary for search params.
 *
 * Progress: record a reading (dated today unless the coach backfills), see
 * the trend, correct or delete past days, and manage goals. Rows the member
 * recorded themselves before coaches took over are READ-ONLY here — deletable,
 * never editable (the server refuses with 409). Nothing on this page decides
 * anything: labels, validation and wire bodies all come from lib/.
 */

type Gate = 'loading' | 'ok' | 'not-assigned' | 'forbidden' | 'failed';

type Tab = 'progress' | 'plan' | 'chat';

/**
 * 404 is every "not mine" — unassigned, ended, deleted, unknown, or my own id
 * — and the server makes them indistinguishable on purpose, so this does too.
 * 403 is "not a coach at all". Anything else is a failure to ASK.
 */
function gateFor(caught: unknown): Gate {
  if (caught instanceof ApiError && caught.status === 404) return 'not-assigned';
  if (caught instanceof ApiError && caught.status === 403) return 'forbidden';
  return 'failed';
}

function tabFromHash(): Tab {
  if (typeof window === 'undefined') return 'progress';
  const hash = window.location.hash.slice(1);
  return hash === 'plan' || hash === 'chat' ? hash : 'progress';
}

export default function CoachMemberPage() {
  const params = useParams<{ memberId: string }>();
  const memberId = params.memberId;

  const [data, setData] = useState<CoachMemberProgress | null>(null);
  const [gate, setGate] = useState<Gate>('loading');
  const [tab, setTab] = useState<Tab>('progress');
  const canPlan = usePermission(PERMISSIONS.WORKOUT_MANAGE);
  const canChat = usePermission(PERMISSIONS.CHAT_USE);
  const chat = useChat();

  useEffect(() => {
    const sync = (): void => setTab(tabFromHash());
    sync();
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
  }, []);

  const choose = (next: Tab): void => {
    setTab(next);
    window.history.replaceState(null, '', `${window.location.pathname}#${next}`);
  };

  /** Refetch after a write. The first load is the effect below. */
  const load = useCallback(async (): Promise<void> => {
    try {
      setData(await coachApi.memberProgress(memberId));
      setGate('ok');
    } catch (caught) {
      setGate(gateFor(caught));
    }
  }, [memberId]);

  useEffect(() => {
    let cancelled = false;
    coachApi.memberProgress(memberId).then(
      (result) => {
        if (cancelled) return;
        setData(result);
        setGate('ok');
      },
      (caught: unknown) => {
        if (!cancelled) setGate(gateFor(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [memberId]);

  if (gate === 'not-assigned') {
    return (
      <Card>
        <EmptyState
          title="This member isn't assigned to you"
          hint="Only a member's current coach can see their progress, plan and chat. If they should be yours, the front desk can assign them."
        />
        <div style={{ textAlign: 'center', paddingBottom: 8 }}>
          <Link href="/portal/coaching/clients" className="p-btn p-btn-ghost p-btn-sm">
            Back to my clients
          </Link>
        </div>
      </Card>
    );
  }

  if (gate === 'forbidden') {
    return (
      <Card>
        <EmptyState
          title="Coaching tools are for coaches"
          hint="Your account is not set up to record members' progress. If that is wrong, the front desk can check it."
        />
      </Card>
    );
  }

  if (gate === 'failed') {
    return (
      <Card>
        <EmptyState
          title="Could not load this member"
          hint="This is usually the network. Reload the page to try again."
        />
      </Card>
    );
  }

  if (gate === 'loading' || data === null) {
    return (
      <div style={{ display: 'grid', gap: 18 }}>
        <Skeleton height={70} />
        <Skeleton height={200} />
        <Skeleton height={220} />
      </div>
    );
  }

  const { member } = data;
  const unread = Object.values(chat?.state.threads ?? {}).find(
    (thread) => thread.role === 'COACH' && thread.member.id === member.id,
  )?.unread;
  const chatBadge = messagesBadge(unread ?? 0);

  const tabs: { id: Tab; label: string; shown: boolean }[] = [
    { id: 'progress', label: 'Progress', shown: true },
    { id: 'plan', label: 'Workout plan', shown: canPlan },
    { id: 'chat', label: 'Chat', shown: canChat },
  ];
  const active = tabs.find((t) => t.id === tab && t.shown)?.id ?? 'progress';

  return (
    <div style={{ display: 'grid', gap: 18 }} className="p-rise">
      <div style={{ display: 'grid', gap: 6 }}>
        <Link
          href="/portal/coaching/clients"
          style={{
            fontSize: 13,
            color: 'var(--p-ink3)',
            textDecoration: 'none',
            width: 'fit-content',
          }}
        >
          ← My clients
        </Link>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h2 className="p-h2" style={{ margin: 0 }}>
            {member.firstName} {member.lastName}
          </h2>
          <span className="p-muted" style={{ fontSize: 13 }}>
            {member.memberCode ?? 'No member code yet'}
          </span>
        </div>
      </div>

      <div className="p-segtabs" role="tablist" aria-label="Client sections">
        {tabs
          .filter((t) => t.shown)
          .map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-controls={`panel-${t.id}`}
              aria-selected={active === t.id}
              className="p-segtab"
              onClick={() => choose(t.id)}
            >
              {t.label}
              {t.id === 'chat' && chatBadge.text !== null ? (
                <>
                  <span className="p-nav-badge" aria-hidden>
                    {chatBadge.text}
                  </span>
                  <span className="sr-only">, {chatBadge.spoken}</span>
                </>
              ) : null}
            </button>
          ))}
      </div>

      <div role="tabpanel" id={`panel-${active}`} aria-labelledby={`tab-${active}`}>
        {active === 'progress' ? <ProgressTab data={data} load={load} /> : null}
        {active === 'plan' ? <WorkoutPlanTab memberId={member.id} /> : null}
        {active === 'chat' ? <ChatTab memberId={member.id} firstName={member.firstName} /> : null}
      </div>
    </div>
  );
}

function ProgressTab({ data, load }: { data: CoachMemberProgress; load: () => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [rowFailure, setRowFailure] = useState<string | null>(null);
  // The gym's civil day, not the phone's: a coach in another zone still
  // records against the day the gym is on.
  const today = gymParts(new Date()).date;

  const act = async (work: () => Promise<unknown>): Promise<void> => {
    setRowFailure(null);
    try {
      await work();
    } catch (caught) {
      setRowFailure(caught instanceof ApiError ? caught.message : 'That did not save. Try again.');
    }
    await load();
  };

  const { member } = data;
  const weighed = data.measurements.filter((m) => m.weightGrams !== null);
  const selfRecorded = (entry: { recordedBy?: unknown }): boolean => entry.recordedBy === null;

  const historyActions = (entry: Measurement) =>
    selfRecorded(entry) ? (
      <>
        <Badge tone="neutral">Self-recorded · read-only</Badge>
        <ConfirmDelete
          label={`the reading for ${formatCivilDate(entry.businessDate)}`}
          onConfirm={() => act(() => coachApi.deleteMeasurement(member.id, entry.id))}
        />
      </>
    ) : (
      <>
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          aria-label={`Edit the reading for ${formatCivilDate(entry.businessDate)}`}
          onClick={() => {
            setRowFailure(null);
            setEditing(entry.id);
          }}
        >
          Edit
        </button>
        <ConfirmDelete
          label={`the reading for ${formatCivilDate(entry.businessDate)}`}
          onConfirm={() => act(() => coachApi.deleteMeasurement(member.id, entry.id))}
        />
      </>
    );

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
          gap: 14,
        }}
      >
        <Stat
          value={data.latestWeightGrams === null ? '—' : `${formatKg(data.latestWeightGrams)}kg`}
          label="Current weight"
        />
        <Stat
          value={data.changeGrams === null ? '—' : `${formatChangeKg(data.changeGrams)}kg`}
          label={data.changeOverDays === null ? 'Change' : `Over ${data.changeOverDays} days`}
          accent
        />
        <Stat
          value={data.bmiThousandths === null ? '—' : formatBmi(data.bmiThousandths)}
          label="BMI"
        />
        <Stat value={data.goals.filter((g) => g.achievedAt === null).length} label="Active goals" />
      </div>

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead title="Record a reading" />
        </div>
        <div className="p-card-pad">
          <MeasurementForm
            today={today}
            onSave={async (body) => {
              await coachApi.recordMeasurement(member.id, body);
              await load();
            }}
          />
        </div>
      </Card>

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead title="Weight" />
        </div>
        <div className="p-card-pad">
          {weighed.length < 2 ? (
            <p style={{ margin: 0, color: 'var(--p-ink3)', fontSize: 13.5 }}>
              {weighed.length === 0
                ? 'No weigh-ins yet. Record one above to start the trend.'
                : 'One more weigh-in and a trend line appears here.'}
            </p>
          ) : (
            <WeightChart points={weighed} />
          )}
        </div>
      </Card>

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="History"
            action={
              <span className="p-muted" style={{ fontSize: 12.5 }}>
                {data.measurements.length} {data.measurements.length === 1 ? 'day' : 'days'}
              </span>
            }
          />
        </div>
        {rowFailure === null ? null : (
          <p role="alert" style={{ margin: '0 18px', fontSize: 13.5, color: 'var(--p-danger)' }}>
            {rowFailure}
          </p>
        )}
        {data.measurements.length === 0 ? (
          <EmptyState
            title="Nothing recorded yet"
            hint="Readings you record appear here, newest first."
          />
        ) : (
          <div style={{ padding: '0 18px 6px' }}>
            <MeasurementHistory
              entries={data.measurements}
              actions={historyActions}
              expanded={(entry) =>
                editing === entry.id ? (
                  <MeasurementEditForm
                    entry={entry}
                    today={today}
                    onCancel={() => setEditing(null)}
                    onSave={async (patch) => {
                      await coachApi.updateMeasurement(member.id, entry.id, patch);
                      setEditing(null);
                      await load();
                    }}
                  />
                ) : null
              }
            />
          </div>
        )}
      </Card>

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead title="Goals" />
        </div>
        <div className="p-card-pad" style={{ display: 'grid', gap: 18 }}>
          {data.goals.length === 0 ? (
            <p style={{ margin: 0, color: 'var(--p-ink3)', fontSize: 13.5 }}>
              No goals yet. Something measurable — lose 5kg, bench 100kg, come 12 times this month.
            </p>
          ) : (
            data.goals.map((goal) => (
              <GoalRow
                key={goal.id}
                goal={goal}
                editable={!selfRecorded(goal)}
                removable
                onPatch={async (patch) => {
                  await coachApi.updateGoal(member.id, goal.id, patch);
                  await load();
                }}
                onRemove={() => act(() => coachApi.deleteGoal(member.id, goal.id))}
              />
            ))
          )}
          <div style={{ borderTop: '1px solid var(--p-border)', paddingTop: 16 }}>
            <div className="p-card-title" style={{ marginBottom: 10 }}>
              Add a goal
            </div>
            <GoalForm
              onSave={async (body) => {
                await coachApi.createGoal(member.id, body);
                await load();
              }}
            />
          </div>
        </div>
      </Card>
    </div>
  );
}
