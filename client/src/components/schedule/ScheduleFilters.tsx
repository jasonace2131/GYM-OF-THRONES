'use client';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { TimeFilter } from '@/lib/schedule/timeOfDay';

export interface CoachOption {
  id: string;
  name: string;
}

const TIMES: readonly [TimeFilter, string][] = [
  ['all', 'All'],
  ['morning', 'Morning'],
  ['afternoon', 'Afternoon'],
  ['evening', 'Evening'],
];

interface ScheduleFiltersProps {
  time: TimeFilter;
  coach: string;
  coaches: CoachOption[];
  onTime: (time: TimeFilter) => void;
  onCoach: (coachId: string) => void;
}

export function ScheduleFilters({ time, coach, coaches, onTime, onCoach }: ScheduleFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={time}
        // Radix sends '' when the pressed item is pressed again; keep a choice.
        onValueChange={(value) => {
          if (value !== '') onTime(value as TimeFilter);
        }}
        aria-label="Time of day"
      >
        {TIMES.map(([value, label]) => (
          <ToggleGroupItem key={value} value={value} className="px-3 font-display text-xs font-semibold">
            {label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <Select value={coach} onValueChange={onCoach}>
        <SelectTrigger size="sm" className="w-[170px] bg-card" aria-label="Coach">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All coaches</SelectItem>
          {coaches.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
