'use client';

import { useCallback, useState } from 'react';
import { GYM_EQUIPMENT_LIMITS, type GymEquipmentItem } from '@got/shared';
import { Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { adminApi } from '@/lib/adminApi';
import { EQUIPMENT_COPY, equipmentProblem, moveId } from '@/lib/gymEquipment';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { ConfirmDialog } from './actions/ConfirmDialog';

/**
 * The gym's equipment list (owner, 2026-10-23). The AI planners — the
 * member's plan, swap and adjust, and the coach's suggester — plan only with
 * what is here or bodyweight. An empty list keeps their old behaviour.
 *
 * Mounted only for `ai.admin.configure`, the key every route behind it checks.
 */
export function EquipmentCard() {
  const query = useAdminQuery(useCallback(() => adminApi.equipment(), []), 'gym-equipment');
  const items = query.data ?? [];

  const [name, setName] = useState('');
  const [detail, setDetail] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string; detail: string } | null>(
    null,
  );
  const [removing, setRemoving] = useState<GymEquipmentItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const namesExcept = (id: string | null): string[] =>
    items.filter((item) => item.id !== id).map((item) => item.name);

  /** One write at a time; reload after, and keep the server's words on failure. */
  const run = async (write: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await write();
      after?.();
      query.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    } finally {
      setBusy(false);
    }
  };

  const add = (): void => {
    const problem = equipmentProblem(name, detail, namesExcept(null));
    if (problem !== null) {
      setError(problem);
      return;
    }
    void run(
      () => adminApi.addEquipment({ name: name.trim(), detail: detail.trim() || null }),
      () => {
        setName('');
        setDetail('');
      },
    );
  };

  const saveEdit = (): void => {
    if (editing === null) return;
    const problem = equipmentProblem(editing.name, editing.detail, namesExcept(editing.id));
    if (problem !== null) {
      setError(problem);
      return;
    }
    void run(
      () =>
        adminApi.updateEquipment(editing.id, {
          name: editing.name.trim(),
          detail: editing.detail.trim() || null,
        }),
      () => setEditing(null),
    );
  };

  const move = (index: number, step: -1 | 1): void => {
    const ids = moveId(
      items.map((item) => item.id),
      index,
      step,
    );
    if (ids !== null) void run(() => adminApi.reorderEquipment(ids));
  };

  return (
    <Card padded={false}>
      <div style={{ padding: '18px 18px 0' }}>
        <CardHead title="Equipment" />
        <p className="p-muted" style={{ fontSize: 12.5, lineHeight: 1.6, margin: '0 0 12px' }}>
          What the gym has. The AI workout planners only use exercises this equipment — or
          bodyweight — allows.
        </p>
      </div>

      <DataState
        loading={query.loading}
        error={query.error}
        empty={items.length === 0}
        emptyTitle={EQUIPMENT_COPY.empty}
        onRetry={query.reload}
        inset
      >
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} aria-label="Gym equipment">
          {items.map((item, index) => (
            <li
              key={item.id}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: 8,
                padding: '10px 18px',
                borderTop: '1px solid var(--p-border)',
              }}
            >
              {editing?.id === item.id ? (
                <>
                  <input
                    className="a-input"
                    value={editing.name}
                    maxLength={GYM_EQUIPMENT_LIMITS.nameMax + 10}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                    aria-label={`Name of ${item.name}`}
                    style={{ flex: '1 1 160px', minWidth: 0 }}
                    disabled={busy}
                  />
                  <input
                    className="a-input"
                    value={editing.detail}
                    maxLength={GYM_EQUIPMENT_LIMITS.detailMax + 10}
                    placeholder="Detail (optional)"
                    onChange={(e) => setEditing({ ...editing, detail: e.target.value })}
                    aria-label={`Detail for ${item.name}`}
                    style={{ flex: '1 1 160px', minWidth: 0 }}
                    disabled={busy}
                  />
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      type="button"
                      className="p-btn p-btn-dark p-btn-sm"
                      onClick={saveEdit}
                      disabled={busy}
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => {
                        setEditing(null);
                        setError(null);
                      }}
                      disabled={busy}
                    >
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <div style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>{item.name}</div>
                    {item.detail === null ? null : (
                      <div className="a-person-sub" style={{ overflowWrap: 'anywhere' }}>
                        {item.detail}
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => move(index, -1)}
                      disabled={busy || index === 0}
                      aria-label={`Move ${item.name} up`}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => move(index, 1)}
                      disabled={busy || index === items.length - 1}
                      aria-label={`Move ${item.name} down`}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => {
                        setError(null);
                        setEditing({ id: item.id, name: item.name, detail: item.detail ?? '' });
                      }}
                      disabled={busy}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="p-btn p-btn-ghost p-btn-sm"
                      onClick={() => {
                        setError(null);
                        setRemoving(item);
                      }}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      </DataState>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          padding: '14px 18px 18px',
          borderTop: '1px solid var(--p-border)',
        }}
      >
        <input
          className="a-input"
          value={name}
          maxLength={GYM_EQUIPMENT_LIMITS.nameMax + 10}
          placeholder="Equipment, e.g. Dumbbells"
          onChange={(e) => setName(e.target.value)}
          aria-label="New equipment name"
          style={{ flex: '1 1 180px', minWidth: 0 }}
          disabled={busy}
        />
        <input
          className="a-input"
          value={detail}
          maxLength={GYM_EQUIPMENT_LIMITS.detailMax + 10}
          placeholder="Detail (optional), e.g. 2–40 kg pairs"
          onChange={(e) => setDetail(e.target.value)}
          aria-label="New equipment detail"
          style={{ flex: '1 1 180px', minWidth: 0 }}
          disabled={busy}
        />
        <button type="submit" className="p-btn p-btn-dark p-btn-sm" disabled={busy}>
          Add equipment
        </button>
      </form>

      {error !== null && removing === null ? (
        <div style={{ padding: '0 18px 18px' }}>
          <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 13, margin: 0 }}>
            {error}
          </p>
        </div>
      ) : null}

      <ConfirmDialog
        open={removing !== null}
        title={`Delete “${removing?.name ?? ''}”?`}
        consequence="The AI planners stop using it from the next plan, swap or adjustment."
        confirmLabel="Delete"
        cancelLabel="Keep it"
        tone="danger"
        busy={busy}
        error={error}
        onConfirm={() => {
          const target = removing;
          if (target === null) return;
          void run(
            () => adminApi.removeEquipment(target.id),
            () => setRemoving(null),
          );
        }}
        onClose={() => {
          if (busy) return;
          setRemoving(null);
          setError(null);
        }}
      />
    </Card>
  );
}
