import { GLOBAL_MODULE_METADATA, MODULE_METADATA } from '@nestjs/common/constants';
import { MeNoticesController } from './me-notices.controller';
import { MemberNoticesService } from './member-notices.service';
import { NotificationsModule } from './notifications.module';

/**
 * The class-booking producers inject `MemberNoticesService` without importing
 * this module. That works only while the module is global AND exports the
 * service — and a unit spec that builds those producers by hand would never
 * notice either one going missing. Only the app's boot would, so it is pinned
 * here instead.
 */
describe('NotificationsModule', () => {
  const metadata = (key: string): unknown => Reflect.getMetadata(key, NotificationsModule);

  it('is global, and provides and exports MemberNoticesService', () => {
    expect(metadata(GLOBAL_MODULE_METADATA)).toBe(true);
    expect(metadata(MODULE_METADATA.PROVIDERS)).toContain(MemberNoticesService);
    expect(metadata(MODULE_METADATA.EXPORTS)).toContain(MemberNoticesService);
  });

  it('mounts the member routes', () => {
    expect(metadata(MODULE_METADATA.CONTROLLERS)).toContain(MeNoticesController);
  });
});
