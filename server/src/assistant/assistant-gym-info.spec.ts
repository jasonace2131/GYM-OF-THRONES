import { AssistantService } from './assistant.service';
import { ASSISTANT_TOOLS } from './assistant.tools';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { DayHours, OpeningHoursService } from '../config/opening-hours.service';
import type { MembershipService } from '../membership/membership.service';
import type { PaymentsService } from '../payments/payments.service';
import type { MeCheckInsService } from '../me/me-check-ins.service';
import type { PlansService } from '../catalogue/plans.service';
import type { GeminiGateway } from './gemini-gateway.service';
import type { AssistantSettingsService } from './assistant-settings.service';

/**
 * get_gym_info reads the hours the DOOR reads — OpeningHoursService, edited in
 * Admin → Settings — never GYM_OPEN_TIME / GYM_CLOSE_TIME directly. Until
 * 2026-10-14 it read the environment, so an edit in Settings moved the door
 * and the website but not the assistant, which kept quoting the old hours and
 * scheduling training sessions around them.
 */
describe('AssistantService — get_gym_info', () => {
  // The environment says 05:00–22:00. Nothing below may echo it.
  const gym = {
    openTime: '05:00',
    closeTime: '22:00',
    timeZone: 'Asia/Manila',
    graceDays: 3,
    freezeMinDays: 7,
    freezeMaxDays: 90,
    freezeAnnualCapDays: 90,
    freezeFeeCentavos: 10000,
  } as unknown as GymConfigService;

  // Settings: closed on Sunday, 06:00–23:00 every other day.
  const week: DayHours[] = Array.from({ length: 7 }, (_, dayOfWeek) => ({
    dayOfWeek,
    opensAt: '06:00',
    closesAt: '23:00',
    isClosed: dayOfWeek === 0,
  }));
  const weekFn = jest.fn().mockResolvedValue(week);
  const forDate = jest.fn().mockResolvedValue(week[1]);

  const service = new AssistantService(
    {} as unknown as PrismaService,
    gym,
    {} as unknown as MembershipService,
    {} as unknown as PaymentsService,
    {} as unknown as MeCheckInsService,
    { listPublic: jest.fn().mockResolvedValue([]) } as unknown as PlansService,
    {} as unknown as GeminiGateway,
    { week: weekFn, forDate } as unknown as OpeningHoursService,
    {} as unknown as AssistantSettingsService,
  );

  // Private, deliberately: the tool's payload is worth reaching in for.
  const gymInfo = (): Promise<Record<string, unknown>> =>
    (
      service as unknown as {
        dispatch: (userId: string, name: string) => Promise<Record<string, unknown>>;
      }
    ).dispatch('u1', 'get_gym_info');

  it("returns today's hours from Settings, by weekday name", async () => {
    const info = await gymInfo();

    expect(info.hours).toMatchObject({
      today: { day: 'Monday', opensAt: '06:00', closesAt: '23:00', isClosed: false },
    });
    expect(forDate).toHaveBeenCalledWith(expect.any(Date));
  });

  it('returns the whole week, Sunday first, with a closed day marked closed', async () => {
    const info = (await gymInfo()) as { hours: { week: unknown[] } };

    expect(info.hours.week).toHaveLength(7);
    expect(info.hours.week[0]).toEqual({
      day: 'Sunday',
      opensAt: '06:00',
      closesAt: '23:00',
      isClosed: true,
    });
    expect(info.hours.week[6]).toMatchObject({ day: 'Saturday' });
  });

  it('never quotes the environment hours', async () => {
    const info = await gymInfo();

    expect(info).not.toHaveProperty('opensAt');
    expect(info).not.toHaveProperty('closesAt');
    const json = JSON.stringify(info);
    expect(json).not.toContain('05:00');
    expect(json).not.toContain('22:00');
  });

  it('still carries the time zone, grace and freeze rules and the plans', async () => {
    await expect(gymInfo()).resolves.toMatchObject({
      timeZone: 'Asia/Manila',
      graceDays: 3,
      freeze: { minDays: 7, maxDays: 90, annualCapDays: 90, feeCentavos: 10000 },
      plans: [],
    });
  });

  it('tells the model that hours differ by day and a day can be closed', () => {
    const tool = ASSISTANT_TOOLS.find((candidate) => candidate.name === 'get_gym_info');
    expect(tool?.description).toContain('a day can be closed');
  });
});
