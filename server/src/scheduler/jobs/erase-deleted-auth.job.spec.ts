import { EraseDeletedAuthJob, ERASE_BATCH } from './erase-deleted-auth.job';
import type { PrismaService } from '../../prisma/prisma.service';
import type { SupabaseAdminService } from '../../auth/supabase-admin.service';
import { DomainException } from '../../common/exceptions/domain.exception';

const NOW = new Date('2026-10-23T03:00:00.000Z');
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function build(rows: { id: string; supabaseId: string; email: string }[]) {
  const user = {
    findMany: jest.fn().mockResolvedValue(rows),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
  };
  const supabase = {
    enabled: true,
    deleteAccountIdentity: jest.fn().mockResolvedValue(undefined),
  };
  const job = new EraseDeletedAuthJob(
    { user } as unknown as PrismaService,
    supabase as unknown as SupabaseAdminService,
  );
  return { job, user, supabase };
}

const owed = (id: string) => ({ id, supabaseId: `sb-${id}`, email: `deleted+${id}@deleted.invalid` });

describe('EraseDeletedAuthJob', () => {
  it('reads only self-deleted rows whose identity is still owed, oldest first, in a batch', async () => {
    const { job, user } = build([]);
    await job.sweep(NOW);
    expect(user.findMany).toHaveBeenCalledWith({
      where: {
        deletedAt: { not: null },
        authErasedAt: null,
        email: { startsWith: 'deleted+', endsWith: '@deleted.invalid' },
      },
      select: { id: true, supabaseId: true, email: true },
      orderBy: { deletedAt: 'asc' },
      take: ERASE_BATCH,
    });
  });

  it('deletes each identity and stamps authErasedAt', async () => {
    const { job, user, supabase } = build([owed(A)]);
    await expect(job.sweep(NOW)).resolves.toEqual({ erased: 1, failed: 0 });
    expect(supabase.deleteAccountIdentity).toHaveBeenCalledWith(`sb-${A}`);
    expect(user.updateMany).toHaveBeenCalledWith({
      where: { id: A, authErasedAt: null },
      data: { authErasedAt: NOW },
    });
  });

  it('keeps going past a failure and leaves that row owed for the next run', async () => {
    const { job, user, supabase } = build([owed(A), owed(B)]);
    supabase.deleteAccountIdentity.mockRejectedValueOnce(
      new DomainException('ACCOUNT_DELETE_FAILED', 'down', 502),
    );
    await expect(job.sweep(NOW)).resolves.toEqual({ erased: 1, failed: 1 });
    expect(user.updateMany).toHaveBeenCalledTimes(1);
    expect(user.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: B, authErasedAt: null } }));
  });

  it("never touches a row whose placeholder is not its own id's", async () => {
    const { job, supabase } = build([{ ...owed(A), email: `deleted+${B}@deleted.invalid` }]);
    await job.sweep(NOW);
    expect(supabase.deleteAccountIdentity).not.toHaveBeenCalled();
  });

  it('does nothing without the service key', async () => {
    const { job, user, supabase } = build([owed(A)]);
    supabase.enabled = false;
    await job.sweep(NOW);
    expect(user.findMany).not.toHaveBeenCalled();
  });
});
