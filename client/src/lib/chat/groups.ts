import { gymToday } from '../gymTime';
import { shortDay } from '../schedule/labels';
import type { TimelineItem } from './chatState';

/**
 * A conversation laid out the way messengers do it: a divider for each gym
 * day, and runs of messages from one person grouped so only the run's last
 * bubble carries the time and the other person's avatar.
 *
 * Pure, and in the GYM's clock — "Today" is the gym's today, the same rule
 * every other date on the portal follows.
 */

/** Two messages from one person this close together read as one run. */
export const GROUP_GAP_MS = 5 * 60_000;

export type TimelineRow =
  | { kind: 'day'; key: string; label: string }
  | {
      kind: 'bubble';
      key: string;
      item: TimelineItem;
      mine: boolean;
      /** ISO instant the bubble was sent (or queued). */
      at: string;
      /** First bubble of a run — its outer corner stays round. */
      first: boolean;
      /** Last bubble of a run — carries the time and the avatar. */
      last: boolean;
    };

function itemAt(item: TimelineItem): string {
  return item.kind === 'message' ? item.message.createdAt : item.pending.createdAt;
}

function itemKey(item: TimelineItem): string {
  return item.kind === 'message' ? item.message.id : item.pending.clientId;
}

function itemMine(item: TimelineItem): boolean {
  // Something still sending was written here, so it is always mine.
  return item.kind === 'pending' ? true : item.mine;
}

/** "Today", "Yesterday", "Mon 5 Oct", or "Mon 5 Oct 2025" for another year. */
export function dayLabel(iso: string, now: Date, timeZone: string): string {
  const day = gymToday(new Date(iso), timeZone);
  const today = gymToday(now, timeZone);
  if (day === today) return 'Today';
  const yesterday = gymToday(new Date(now.getTime() - 86_400_000), timeZone);
  if (day === yesterday) return 'Yesterday';
  // Spelled out by table (lib/schedule/labels), not Intl: ICU's punctuation
  // around the year changes between releases.
  return day.slice(0, 4) === today.slice(0, 4)
    ? shortDay(day)
    : `${shortDay(day)} ${day.slice(0, 4)}`;
}

export function groupTimeline(
  items: readonly TimelineItem[],
  now: Date,
  timeZone: string,
): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let lastDay: string | null = null;
  let previous: { mine: boolean; at: number; day: string } | null = null;

  items.forEach((item) => {
    const at = itemAt(item);
    const atMs = new Date(at).getTime();
    const day = gymToday(new Date(at), timeZone);
    const mine = itemMine(item);

    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: dayLabel(at, now, timeZone) });
      lastDay = day;
    }

    const continues =
      previous !== null &&
      previous.mine === mine &&
      previous.day === day &&
      atMs - previous.at <= GROUP_GAP_MS;

    if (continues) {
      // The bubble before this one is no longer the end of its run.
      const before = rows[rows.length - 1];
      if (before !== undefined && before.kind === 'bubble') before.last = false;
    }

    rows.push({
      kind: 'bubble',
      key: itemKey(item),
      item,
      mine,
      at,
      first: !continues,
      last: true,
    });
    previous = { mine, at: atMs, day };
  });

  return rows;
}
