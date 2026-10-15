import type { Prisma } from '@prisma/client';
import { bumpPermissionVersionForRoles, bumpPermissionVersionForUsers } from './permission-version';

describe('permission version bumps', () => {
  let updateMany: jest.Mock;
  let tx: Prisma.TransactionClient;

  beforeEach(() => {
    updateMany = jest.fn().mockResolvedValue({ count: 7 });
    tx = { user: { updateMany } } as unknown as Prisma.TransactionClient;
  });

  it('increments — never assigns — for every user holding an affected role', async () => {
    await expect(bumpPermissionVersionForRoles(tx, ['ADMIN', 'FRONT_DESK'])).resolves.toBe(7);
    expect(updateMany).toHaveBeenCalledWith({
      where: { role: { in: ['ADMIN', 'FRONT_DESK'] } },
      data: { permissionVersion: { increment: 1 } },
    });
  });

  it('increments for exactly the named users', async () => {
    await expect(bumpPermissionVersionForUsers(tx, ['user-a', 'user-b'])).resolves.toBe(7);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['user-a', 'user-b'] } },
      data: { permissionVersion: { increment: 1 } },
    });
  });

  it('issues no statement for an empty role list', async () => {
    await expect(bumpPermissionVersionForRoles(tx, [])).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('issues no statement for an empty user list', async () => {
    await expect(bumpPermissionVersionForUsers(tx, [])).resolves.toBe(0);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
