import { CODE_ALPHABET, MEMBER_CODE_LENGTH } from '@got/shared';
import { allocateMemberCode, generateMemberCode } from './member-code.util';

describe('generateMemberCode', () => {
  it('emits exactly MEMBER_CODE_LENGTH characters', () => {
    expect(generateMemberCode()).toHaveLength(MEMBER_CODE_LENGTH);
  });

  it('draws only from the Crockford alphabet, never I, L, O or U', () => {
    for (let i = 0; i < 2000; i += 1) {
      const code = generateMemberCode();
      for (const char of code) {
        expect(CODE_ALPHABET).toContain(char);
      }
      expect(code).not.toMatch(/[ILOU]/);
    }
  });

  it('maps CSPRNG bytes uniformly — 256 is an exact multiple of 32', () => {
    const counts = new Map<string, number>();

    for (let byte = 0; byte < 256; byte += 1) {
      const code = generateMemberCode(() =>
        Buffer.from(new Array<number>(MEMBER_CODE_LENGTH).fill(byte)),
      );
      counts.set(code[0], (counts.get(code[0]) ?? 0) + 1);
    }

    expect(counts.size).toBe(32);
    // Every character drawn exactly 8 times: no modulo bias.
    expect([...new Set(counts.values())]).toEqual([8]);
  });

  it('is deterministic given the bytes', () => {
    const code = generateMemberCode(() => Buffer.from([0, 1, 2, 3, 4, 31]));
    expect(code).toBe('01234Z');
  });
});

describe('allocateMemberCode', () => {
  function txWithClashes(clashes: number): {
    tx: Parameters<typeof allocateMemberCode>[0];
    findFirst: jest.Mock;
  } {
    let seen = 0;
    const findFirst = jest.fn().mockImplementation(() => {
      seen += 1;
      return Promise.resolve(seen <= clashes ? { id: 'taken' } : null);
    });
    return {
      tx: { user: { findFirst } } as unknown as Parameters<typeof allocateMemberCode>[0],
      findFirst,
    };
  }

  it('returns the first code that is free', async () => {
    const { tx, findFirst } = txWithClashes(0);
    await expect(allocateMemberCode(tx)).resolves.toHaveLength(MEMBER_CODE_LENGTH);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('retries past a collision', async () => {
    const { tx, findFirst } = txWithClashes(2);
    await expect(allocateMemberCode(tx)).resolves.toHaveLength(MEMBER_CODE_LENGTH);
    expect(findFirst).toHaveBeenCalledTimes(3);
  });

  it('throws after a bounded number of attempts rather than looping forever', async () => {
    const { tx, findFirst } = txWithClashes(Number.MAX_SAFE_INTEGER);
    await expect(allocateMemberCode(tx, 3)).rejects.toThrow(
      'Could not allocate a unique memberCode after 3 attempts',
    );
    expect(findFirst).toHaveBeenCalledTimes(3);
  });
});
