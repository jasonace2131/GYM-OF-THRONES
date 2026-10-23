import { MembershipImportService, placeholderEmails } from './membership-import.service';
import type { AuthUser } from '../auth/auth.types';
import type { ImportMembershipsDto } from './dto/import-memberships.dto';

describe('placeholderEmails', () => {
  it('keys on the stored 639… digits, remembering the legacy 09… key', () => {
    expect(placeholderEmails('+639171234567')).toEqual({
      current: '639171234567@imported.gymofthrones.invalid',
      legacy: '09171234567@imported.gymofthrones.invalid',
    });
  });
});

describe('MembershipImportService — phone-only re-import is idempotent', () => {
  const actor = { id: 'actor' } as AuthUser;
  const row = {
    phone: '+639171234567',
    firstName: 'Ana',
    lastName: 'Cruz',
    planCode: 'MONTHLY',
    startsOn: '2026-01-01',
    endsOn: '2026-02-01',
    joinedOn: '2026-01-01',
  };
  const dto = { confirm: true, rows: [row] } as unknown as ImportMembershipsDto;

  function setup(existingEmails: string[]) {
    const users = new Set(existingEmails);
    const tx = {
      user: {
        findUnique: jest.fn(({ where }: { where: { email: string } }) =>
          Promise.resolve(users.has(where.email) ? { id: 'u-legacy' } : null),
        ),
        createMany: jest.fn(({ data }: { data: Array<{ email: string }> }) => {
          const email = data[0]!.email;
          if (users.has(email)) return Promise.resolve({ count: 0 });
          users.add(email);
          return Promise.resolve({ count: 1 });
        }),
        findUniqueOrThrow: jest.fn(() => Promise.resolve({ id: 'u-legacy', memberCode: 'ABC123' })),
        update: jest.fn(),
      },
      membership: {
        findUnique: jest.fn(() => Promise.resolve({ id: 'm-1' })),
        create: jest.fn(),
      },
    };
    const prisma = { $transaction: (cb: (t: typeof tx) => unknown) => cb(tx) };
    const plans = { requireSellable: jest.fn(() => Promise.resolve({ id: 'p', code: 'MONTHLY' })) };
    const service = new MembershipImportService(prisma as never, {} as never, plans as never);
    return { service, tx, users };
  }

  it('finds a member imported under the legacy 09… key and skips, minting no duplicate', async () => {
    const { service, tx, users } = setup(['09171234567@imported.gymofthrones.invalid']);
    await expect(service.importMembers(actor, dto, new Date())).resolves.toEqual({
      created: 0,
      skipped: 1,
      errors: [],
    });
    expect(tx.user.createMany.mock.calls[0]![0].data[0].email).toBe(
      '09171234567@imported.gymofthrones.invalid',
    );
    expect(users.has('639171234567@imported.gymofthrones.invalid')).toBe(false);
    expect(tx.membership.create).not.toHaveBeenCalled();
  });

  it('a new phone-only row is keyed on the 639… digits', async () => {
    const { service, tx } = setup([]);
    tx.membership.findUnique.mockResolvedValue(null as never);
    await service.importMembers(actor, dto, new Date()).catch(() => undefined);
    expect(tx.user.createMany.mock.calls[0]![0].data[0].email).toBe(
      '639171234567@imported.gymofthrones.invalid',
    );
  });
});
