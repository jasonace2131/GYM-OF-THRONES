import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import { CreateStationCredentialDto, UpdateStationDto } from './dto/station.dto';
import { StationsService } from './stations.service';
import type {
  AdminStation,
  AdminStationCredential,
  IssuedStationCredential,
} from './station.presenter';

/**
 * Routes 56 and 57, plus the credential surface the station display cannot
 * exist without.
 *
 * `station.manage` is ADMIN-only and `isDangerous`. Two of the three actions
 * here take a check-in point offline — one of them instantly, for every member
 * currently walking towards it — and that is a decision with a name attached,
 * not a front-desk convenience.
 */
@Controller('admin/stations')
export class AdminStationsController {
  constructor(private readonly stations: StationsService) {}

  @Get()
  @RequirePermission('station.manage')
  async list(): Promise<AdminStation[]> {
    return this.stations.list();
  }

  /**
   * A second station is a real event (a new entrance, a second branch), not a
   * routine one — hence the idempotency key: creating two stations from one
   * double-tapped button would put two codes on one door and make "which door
   * did they come in" permanently ambiguous for every row written afterwards.
   */
  @Post()
  @RequirePermission('station.manage')
  @Idempotent()
  async create(@Body() body: CreateStationCredentialDto): Promise<AdminStation> {
    return this.stations.create(body.label);
  }

  @Patch(':id')
  @RequirePermission('station.manage')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStationDto,
  ): Promise<AdminStation> {
    return this.stations.update(id, body);
  }

  /**
   * THE SECRET IN THIS RESPONSE IS SHOWN ONCE AND IS NEVER RECOVERABLE.
   *
   * Rate-limited hard: this is the one endpoint that mints a credential which
   * bypasses `PermissionsGuard` entirely, and there is no legitimate reason to
   * call it more than a handful of times in a day.
   */
  @Post(':id/credentials')
  @RequirePermission('station.manage')
  @Idempotent()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  async issueCredential(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateStationCredentialDto,
    @CurrentUser() user: AuthUser,
  ): Promise<IssuedStationCredential> {
    return this.stations.issueCredential(id, body.label, user.id);
  }

  /**
   * Revoke, never delete — and idempotent, so a double-tap on a panicked
   * click never answers 404 to someone who is trying to shut a tablet down.
   */
  @Delete('credentials/:credentialId')
  @RequirePermission('station.manage')
  async revokeCredential(
    @Param('credentialId', ParseUUIDPipe) credentialId: string,
  ): Promise<AdminStationCredential> {
    return this.stations.revokeCredential(credentialId);
  }
}
