import { describe, expect, it } from 'vitest';
import { EQUIPMENT_COPY, equipmentProblem, moveId } from './gymEquipment';

describe('the equipment list editor', () => {
  it('moves an id up or down, and not past either end', () => {
    expect(moveId(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c']);
    expect(moveId(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b']);
    expect(moveId(['a', 'b', 'c'], 0, -1)).toBeNull();
    expect(moveId(['a', 'b', 'c'], 2, 1)).toBeNull();
  });

  it('checks a name and detail the way the API will', () => {
    expect(equipmentProblem('Dumbbells', '2–40 kg pairs', [])).toBeNull();
    expect(equipmentProblem('   ', '', [])).toBe('Give the equipment a name.');
    expect(equipmentProblem('x'.repeat(81), '', [])).toBe('Keep the name to 80 characters.');
    expect(equipmentProblem('Bench', 'x'.repeat(121), [])).toBe(
      'Keep the detail to 120 characters.',
    );
    expect(equipmentProblem(' dumbbells ', '', ['Dumbbells'])).toBe(
      'That equipment is already on the list.',
    );
  });

  it('says what an empty list means for the AI', () => {
    expect(EQUIPMENT_COPY.empty).toBe(
      'No equipment listed. The AI plans with bodyweight and common gym basics until you add some.',
    );
  });
});
