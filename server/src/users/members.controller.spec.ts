import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Role, UserStatus } from '@prisma/client';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { MembersController } from './members.controller';
import type { MembersService } from './members.service';
import type { AuthUser } from '../auth/auth.types';

const MEMBER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const CALLER: AuthUser = {
  id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  supabaseId: '11111111-1111-1111-1111-111111111111',
  email: 'admin@example.com',
  firstName: 'Admin',
  lastName: 'User',
  role: Role.ADMIN,
  status: UserStatus.ACTIVE,
  permissionVersion: 0,
  heightCm: null,
  weightKg: null,
  deletedAt: null,
};

const SCOPE = {} as never;

/**
 * Thin wiring tests: every one of these five handlers is a pass-through, and
 * the risk this file guards against is an argument in the wrong position —
 * `user.id` vs `user`, or the actor id landing in the wrong parameter slot —
 * which a type error would not always catch (both `id` params are `string`).
 */
describe('MembersController — write routes', () => {
  function buildController(): { controller: MembersController; members: jest.Mocked<MembersService> } {
    const members = {
      list: jest.fn(),
      findOne: jest.fn(),
      counts: jest.fn(),
      update: jest.fn(),
      suspend: jest.fn(),
      reactivate: jest.fn(),
      remove: jest.fn(),
      restore: jest.fn(),
      changeRole: jest.fn(),
      create: jest.fn(),
      resendInvite: jest.fn(),
      changeEmail: jest.fn(),
    } as unknown as jest.Mocked<MembersService>;
    return { controller: new MembersController(members), members };
  }

  // The Origin header is how the setup link is built on the site the desk is
  // actually using (`resolveAppOrigin` checks it against CORS_ORIGIN).
  const ORIGIN = 'https://site.test';

  it('create() forwards the dto, the CALLER object (not just its id) and the origin', async () => {
    const { controller, members } = buildController();
    const dto = {
      firstName: 'Jon',
      lastName: 'Snow',
      email: 'jon@example.com',
      dateOfBirth: '1995-05-05',
    };
    members.create.mockResolvedValue('result' as never);

    await controller.create(dto, CALLER, ORIGIN);

    expect(members.create).toHaveBeenCalledWith(dto, CALLER, ORIGIN);
  });

  it('resendInvite() forwards id, scope, the caller (who issued the link) and the origin', async () => {
    const { controller, members } = buildController();
    members.resendInvite.mockResolvedValue('result' as never);

    await controller.resendInvite(MEMBER_ID, SCOPE, CALLER, ORIGIN);

    expect(members.resendInvite).toHaveBeenCalledWith(MEMBER_ID, SCOPE, CALLER, ORIGIN);
  });

  it('changeEmail() forwards id, the email, scope, the caller and the origin', async () => {
    const { controller, members } = buildController();
    members.changeEmail.mockResolvedValue('result' as never);

    await controller.changeEmail(MEMBER_ID, { email: 'new@example.com' }, SCOPE, CALLER, ORIGIN);

    expect(members.changeEmail).toHaveBeenCalledWith(
      MEMBER_ID,
      'new@example.com',
      SCOPE,
      CALLER,
      ORIGIN,
    );
  });

  it('changeEmail is POST :id/change-email, 200, under member.create — it finishes the create', () => {
    const handler = MembersController.prototype['changeEmail'];
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/change-email');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler)).toBe('member.create');
  });

  it('update() forwards id, dto and scope', async () => {
    const { controller, members } = buildController();
    const dto = { firstName: 'Aegon' };
    members.update.mockResolvedValue('result' as never);

    await controller.update(MEMBER_ID, dto, SCOPE);

    expect(members.update).toHaveBeenCalledWith(MEMBER_ID, dto, SCOPE);
  });

  // Staff & Access: every account write forwards the CALLER, not just their
  // id — the role hierarchy needs the caller's role ("only below your own"),
  // and the self-guards still need the id. Both come off the verified token.
  it('suspend() forwards id, dto, the caller and scope', async () => {
    const { controller, members } = buildController();
    const dto = { reason: 'Chargeback dispute' };
    members.suspend.mockResolvedValue('result' as never);

    await controller.suspend(MEMBER_ID, dto, CALLER, SCOPE);

    expect(members.suspend).toHaveBeenCalledWith(MEMBER_ID, dto, CALLER, SCOPE);
  });

  it('reactivate() forwards id, the caller and scope — no dto', async () => {
    const { controller, members } = buildController();
    members.reactivate.mockResolvedValue('result' as never);

    await controller.reactivate(MEMBER_ID, CALLER, SCOPE);

    expect(members.reactivate).toHaveBeenCalledWith(MEMBER_ID, CALLER, SCOPE);
  });

  it('remove() forwards id, the caller and scope — the self-delete guard needs the actor', async () => {
    const { controller, members } = buildController();
    members.remove.mockResolvedValue('result' as never);

    await controller.remove(MEMBER_ID, CALLER, SCOPE);

    expect(members.remove).toHaveBeenCalledWith(MEMBER_ID, CALLER, SCOPE);
  });

  it('restore() forwards id, the caller and scope', async () => {
    const { controller, members } = buildController();
    members.restore.mockResolvedValue('result' as never);

    await controller.restore(MEMBER_ID, CALLER, SCOPE);

    expect(members.restore).toHaveBeenCalledWith(MEMBER_ID, CALLER, SCOPE);
  });

  it('changeRole() forwards id, dto, the caller and scope', async () => {
    const { controller, members } = buildController();
    const dto = { role: Role.COACH };
    members.changeRole.mockResolvedValue('result' as never);

    await controller.changeRole(MEMBER_ID, dto, CALLER, SCOPE);

    expect(members.changeRole).toHaveBeenCalledWith(MEMBER_ID, dto, CALLER, SCOPE);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * `/members/counts` IS A LITERAL PATH COMPETING WITH `/members/:id`.
   *
   * Nest matches in DECLARATION order, so `@Get('counts')` must be declared
   * ABOVE `@Get(':id')` or the request lands on `findOne` and dies in
   * `ParseUUIDPipe` with a 400 on the string "counts" — a failure that reads
   * like a client bug and is nowhere near the routing table that caused it.
   *
   * The two tests below are the guard. The first asserts the handler exists
   * and passes its arguments through; the second reads the ACTUAL registered
   * path metadata off the prototype, in declaration order, so re-ordering the
   * two methods fails here rather than at the counter.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it('counts() forwards the query and scope — not the id pipe, not findOne', async () => {
    const { controller, members } = buildController();
    const query = { deleted: false };
    members.counts.mockResolvedValue('result' as never);

    await controller.counts(query as never, SCOPE);

    expect(members.counts).toHaveBeenCalledWith(query, SCOPE);
    expect(members.findOne).not.toHaveBeenCalled();
  });

  it("declares @Get('counts') BEFORE @Get(':id'), which is what makes it routable", () => {
    const names = Object.getOwnPropertyNames(MembersController.prototype);
    expect(names.indexOf('counts')).toBeGreaterThan(-1);
    expect(names.indexOf('counts')).toBeLessThan(names.indexOf('findOne'));

    // And the literal really is the literal — a `@Get()` with no argument
    // would also sort ahead of `:id` and still never match.
    const path: unknown = Reflect.getMetadata('path', MembersController.prototype['counts']);
    expect(path).toBe('counts');
  });
});
