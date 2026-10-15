import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PaginatedData } from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Scope } from '../rbac/decorators/scope.decorator';
import type { ScopedWhere } from '../rbac/scope.util';
import { ListMembersQueryDto } from './dto/list-members-query.dto';
import { MemberCountsQueryDto } from './dto/member-counts-query.dto';
import { UpdateMemberDto } from './dto/update-member.dto';
import { SuspendMemberDto } from './dto/suspend-member.dto';
import { ChangeRoleDto } from './dto/change-role.dto';
import { CreateMemberDto } from './dto/create-member.dto';
import { ChangeMemberEmailDto } from './dto/change-email.dto';
import { MembersService, type CreateMemberResult, type MemberCounts } from './members.service';
import type { MemberListItem } from './members.presenter';

type MemberScope = ScopedWhere<Prisma.UserWhereInput>;

/**
 * Routes 16 and 17 (list, read) plus C1's five write routes.
 *
 * `@Scope('user')` is what makes a COACH holding `member.read` at OWN see only
 * themselves rather than the whole roster. The scope comes from the stash
 * `PermissionsGuard` already resolved for THIS route's key, so the key is
 * spelled exactly once, in `@RequirePermission()`. Every write route below
 * keeps `@Scope('user')` too, for the same 404-not-403 reason `findOne` below
 * has it: today only ADMIN (scope ALL) holds `member.update` / `.suspend` /
 * `.delete` / `role.change`, but a scoped miss must read as "not found" the
 * moment any role is ever granted one of these at OWN.
 */
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  @Get()
  @RequirePermission('member.read')
  async list(
    @Query() query: ListMembersQueryDto,
    @Scope('user') scope: MemberScope,
  ): Promise<PaginatedData<MemberListItem>> {
    return this.members.list(query, scope);
  }

  /**
   * `GET /members/counts` — the roster's KPI tiles, one round trip.
   *
   * ───────────────────────────────────────────────────────────────────────
   * DECLARED BEFORE `@Get(':id')`, AND THAT ORDER IS LOAD-BEARING.
   *
   * Nest matches routes in DECLARATION order. Below `@Get(':id')`, this path
   * never runs: `/members/counts` binds `id = 'counts'`, and
   * `ParseUUIDPipe({ version: '4' })` rejects it as a 400 that reads like a
   * client bug and points nowhere near the routing table that caused it.
   * `members.controller.spec.ts` asserts this ordering off the prototype so
   * re-arranging the file fails a test rather than a counter.
   *
   * Same `member.read` key and same `@Scope('user')` as the list: these ARE
   * the list's totals, so any divergence between the two would mean a tile
   * counting rows the table refuses to show.
   * ───────────────────────────────────────────────────────────────────────
   */
  @Get('counts')
  @RequirePermission('member.read')
  async counts(
    @Query() query: MemberCountsQueryDto,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberCounts> {
    return this.members.counts(query, scope);
  }

  /** 404 on a scoped miss, never 403 — a 403 is an enumeration oracle. */
  @Get(':id')
  @RequirePermission('member.read')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.findOne(id, scope);
  }

  /**
   * `POST /members` — C2. `@HttpCode` is left at Nest's POST default (201):
   * this creates a row, unlike `/suspend` and `/reactivate` above.
   *
   * No `@Scope('user')`: there is no existing row to be out of reach of —
   * every caller who holds `member.create` may create a member.
   */
  @Post()
  @RequirePermission('member.create')
  async create(
    @Body() dto: CreateMemberDto,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<CreateMemberResult> {
    return this.members.create(dto, user, origin);
  }

  /**
   * `POST /members/:id/resend-invite` — the UI's answer to `emailSent: false`
   * from `create`. Rotates the member's setup link (the old one dies) and emails
   * the new one; refused (409) for a member who has ever signed in. Same
   * permission as creation: this re-sends the SAME kind of email, not a new
   * capability. `@Scope('user')` for the usual 404-not-403 reason: this acts on
   * an EXISTING row, unlike `create` above.
   */
  @Post(':id/resend-invite')
  @HttpCode(200)
  @RequirePermission('member.create')
  async resendInvite(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Scope('user') scope: MemberScope,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    return this.members.resendInvite(id, scope, user, origin);
  }

  /**
   * `POST /members/:id/change-email` — correct a mistyped address on a member
   * who has never signed in, and send the setup link to the new one. Same
   * permission as creating the member: it finishes the same job.
   */
  @Post(':id/change-email')
  @HttpCode(200)
  @RequirePermission('member.create')
  async changeEmail(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeMemberEmailDto,
    @Scope('user') scope: MemberScope,
    @CurrentUser() user: AuthUser,
    @Headers('origin') origin: string | undefined,
  ): Promise<{ member: MemberListItem; emailSent: boolean }> {
    return this.members.changeEmail(id, dto.email, scope, user, origin);
  }

  /** Name, phone, emergency contact. */
  @Patch(':id')
  @RequirePermission('member.update')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMemberDto,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.update(id, dto, scope);
  }

  /**
   * Check-in only — portal login is untouched. See
   * `MembersService.suspend`'s doc comment for how the door enforces this.
   * `@HttpCode(200)`: this mutates an existing row, it does not create one.
   */
  @Post(':id/suspend')
  @HttpCode(200)
  @RequirePermission('member.suspend')
  async suspend(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: SuspendMemberDto,
    @CurrentUser() user: AuthUser,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.suspend(id, dto, user, scope);
  }

  /**
   * No `@Body()` param — a body sent here is never bound to a DTO, so
   * `forbidNonWhitelisted` never runs against it and it is silently ignored,
   * not rejected. Reactivate needs no input: it unconditionally clears the
   * suspension.
   */
  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('member.suspend')
  async reactivate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthUser,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.reactivate(id, user, scope);
  }

  /** Soft — sets `deletedAt`. Returns the pre-delete snapshot, not 204. */
  @Delete(':id')
  @RequirePermission('member.delete')
  async remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @CurrentUser() user: AuthUser,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.remove(id, user, scope);
  }

  /**
   * `POST /members/:id/restore` — the undo for `remove`, on `member.delete`
   * rather than a key of its own: the capability being exercised is the same
   * one, in the other direction, and a role trusted to soft-delete a member is
   * exactly the role that should be able to put them back. `@HttpCode(200)`
   * and `@Scope('user')` for the same reasons every other write route has
   * them.
   */
  @Post(':id/restore')
  @HttpCode(200)
  @RequirePermission('member.delete')
  async restore(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    // Names the actor in the audit entry, and gives the role hierarchy the
    // caller's role: putting a deleted ADMIN back is the Super Admin's call.
    @CurrentUser() user: AuthUser,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.restore(id, user, scope);
  }

  /**
   * Guard: a caller cannot change their own role, and the role hierarchy
   * (`@got/shared` role-hierarchy) decides which roles they may give and to
   * whom — only DEV manages ADMINs, and never the last active one.
   */
  @Post(':id/role')
  @HttpCode(200)
  @RequirePermission('role.change')
  async changeRole(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ChangeRoleDto,
    @CurrentUser() user: AuthUser,
    @Scope('user') scope: MemberScope,
  ): Promise<MemberListItem> {
    return this.members.changeRole(id, dto, user, scope);
  }
}
