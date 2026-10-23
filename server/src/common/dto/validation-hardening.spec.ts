import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { VoidPaymentDto } from '../../payments/dto/void-payment.dto';
import { AmendPaymentDto } from '../../payments/dto/amend-payment.dto';
import { RecordPaymentDto } from '../../payments/dto/record-payment.dto';
import { CreateGcashSubmissionDto } from '../../payments/dto/gcash-submission.dto';
import { CloseShiftDto } from '../../payments/dto/shift.dto';
import { CancelMembershipDto, RequestCancellationDto } from '../../membership/dto/cancellation.dto';
import { AdjustTermDto, CorrectMembershipDto } from '../../membership/dto/adjust-term.dto';
import {
  FreezeMembershipDto,
  UnfreezeMembershipDto,
} from '../../membership/dto/freeze-membership.dto';
import { ExtendAllDto, ImportMemberRowDto } from '../../membership/dto/import-memberships.dto';
import { CreateMembershipDto } from '../../membership/dto/create-membership.dto';
import { RenewMembershipDto } from '../../membership/dto/renew-membership.dto';
import { SellWalkInDto } from '../../front-desk/dto/sell-walk-in.dto';
import { SubmitLeadDto } from '../../contact/dto/submit-lead.dto';
import { UpdateLeadDto } from '../../contact/dto/update-lead.dto';
import { CreatePromotionDto, QuotePromotionDto } from '../../catalogue/dto/promotion.dto';
import { CreatePlanDto } from '../../catalogue/dto/create-plan.dto';
import { UpdatePlanDto } from '../../catalogue/dto/update-plan.dto';
import { CreateMemberDto } from '../../users/dto/create-member.dto';
import { UpdateMemberDto } from '../../users/dto/update-member.dto';
import { AcceptMemberJoinDto } from '../../users/dto/member-join.dto';
import { CreateAnnouncementDto } from '../../announcements/dto/create-announcement.dto';
import { latestToday } from '../validators/is-birth-date.validator';

type Ctor = new () => object;

/** The app's ValidationPipe (main.ts): implicit conversion, whitelist, forbid unknown. */
function run(cls: Ctor, payload: Record<string, unknown>): { dto: any; failed: string[] } {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
  const failed = errors.map((e) => e.property);
  return { dto, failed };
}

const CONFIRM = { confirm: true };

describe('reason fields refuse whitespace-only text (it used to 500 on a CHECK)', () => {
  const cases: Array<[string, Ctor, Record<string, unknown>]> = [
    ['void payment', VoidPaymentDto, { ...CONFIRM, kind: 'ERROR' }],
    ['amend payment', AmendPaymentDto, CONFIRM],
    ['request cancellation', RequestCancellationDto, {}],
    ['cancel membership', CancelMembershipDto, CONFIRM],
    ['adjust term', AdjustTermDto, { ...CONFIRM, days: 3 }],
    ['correct membership', CorrectMembershipDto, CONFIRM],
    ['freeze', FreezeMembershipDto, { startsOn: '2026-11-01', endsOn: '2026-11-10' }],
    ['extend all', ExtendAllDto, { ...CONFIRM, days: 3, batchRef: 'TYPHOON-1' }],
  ];

  it.each(cases)('%s', (_label, cls, base) => {
    expect(run(cls, { ...base, reason: '      ' }).failed).toContain('reason');
    const ok = run(cls, { ...base, reason: '  Typhoon closure  ' });
    expect(ok.failed).not.toContain('reason');
    expect(ok.dto.reason).toBe('Typhoon closure');
  });

  it('an optional unfreeze reason is trimmed too', () => {
    expect(run(UnfreezeMembershipDto, { reason: '    ' }).failed).toEqual(['reason']);
  });
});

describe('payment references: one rule, 4–64, trimmed, a letter or digit required', () => {
  it.each([
    ['record payment', RecordPaymentDto, { purpose: 'MEMBERSHIP', planCode: 'MONTHLY', grossCentavos: 100, method: 'GCASH' }],
    ['create membership', CreateMembershipDto, { userId: '11111111-1111-4111-8111-111111111111', planCode: 'MONTHLY', method: 'GCASH' }],
    ['renew', RenewMembershipDto, { planCode: 'MONTHLY', method: 'GCASH' }],
    ['walk-in', SellWalkInDto, { kind: 'WALK_IN', method: 'GCASH' }],
    ['gcash submission', CreateGcashSubmissionDto, { planCode: 'MONTHLY', amountCentavos: 100, proofPath: 'members/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg' }],
  ] as Array<[string, Ctor, Record<string, unknown>]>)('%s', (_label, cls, base) => {
    expect(run(cls, { ...base, reference: '   ' }).failed).toContain('reference');
    expect(run(cls, { ...base, reference: '----' }).failed).toContain('reference');
    expect(run(cls, { ...base, reference: '123' }).failed).toContain('reference');
    expect(run(cls, { ...base, reference: 'x'.repeat(65) }).failed).toContain('reference');
    const ok = run(cls, { ...base, reference: ' 1234 5678 9012 3 ' });
    expect(ok.failed).toEqual([]);
    expect(ok.dto.reference).toBe('1234 5678 9012 3');
  });

  it('an amend may still send a blank reference to clear it', () => {
    expect(run(AmendPaymentDto, { ...CONFIRM, reason: 'typo fix', reference: '' }).failed).toEqual([]);
  });

  it('a GCash claim is held to the same centavos ceiling as every sale', () => {
    const base = { planCode: 'MONTHLY', reference: '1234567890123', proofPath: 'members/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.jpg' };
    expect(run(CreateGcashSubmissionDto, { ...base, amountCentavos: 10_000_001 }).failed).toEqual(['amountCentavos']);
  });
});

describe('walk-in guest', () => {
  const base = { kind: 'WALK_IN' };
  it('normalises the guest phone and refuses letters or a landline', () => {
    expect(run(SellWalkInDto, { ...base, guestPhone: '0917 123 4567' }).dto.guestPhone).toBe('+639171234567');
    expect(run(SellWalkInDto, { ...base, guestPhone: '0917abc4567' }).failed).toEqual(['guestPhone']);
    expect(run(SellWalkInDto, { ...base, guestPhone: '8123 4567' }).failed).toEqual(['guestPhone']);
  });
  it('holds the guest name to the name rule, two characters minimum', () => {
    expect(run(SellWalkInDto, { ...base, guestName: 'J' }).failed).toEqual(['guestName']);
    expect(run(SellWalkInDto, { ...base, guestName: 'Juan 3' }).failed).toEqual(['guestName']);
    expect(run(SellWalkInDto, { ...base, guestName: '  Niña   Cruz ' }).dto.guestName).toBe('Niña Cruz');
  });
  it('caps netCentavos and widens the statutory ID to 64', () => {
    expect(run(SellWalkInDto, { ...base, netCentavos: 10_000_001 }).failed).toEqual(['netCentavos']);
    expect(run(SellWalkInDto, { ...base, statutoryIdNo: 'x'.repeat(64) }).failed).toEqual([]);
    expect(run(SellWalkInDto, { ...base, statutoryIdNo: '   ' }).failed).toEqual(['statutoryIdNo']);
  });
});

describe('contact form lead', () => {
  it('normalises the phone and refuses a name with digits', () => {
    const ok = run(SubmitLeadDto, { name: 'Ana Cruz', phone: '0917-123-4567' });
    expect(ok.failed).toEqual([]);
    expect(ok.dto.phone).toBe('+639171234567');
    expect(run(SubmitLeadDto, { name: 'Ana 2', email: 'a@b.co' }).failed).toEqual(['name']);
    expect(run(SubmitLeadDto, { name: 'Ana', phone: 'call me' }).failed).toContain('phone');
  });
  it('refuses a lead with neither an email nor a phone (Lead CHECK)', () => {
    expect(run(SubmitLeadDto, { name: 'Ana' }).failed).toEqual(['email']);
    expect(run(SubmitLeadDto, { name: 'Ana', phone: '   ' }).failed).toEqual(['email']);
  });
  it('turns blank staff notes into null instead of breaking Lead_notes_sane', () => {
    const { dto, failed } = run(UpdateLeadDto, { notes: '   ' });
    expect(failed).toEqual([]);
    expect(dto.notes).toBeNull();
  });
});

describe('promotions', () => {
  it('validates the quote body (it was an inline type, never checked)', () => {
    expect(run(QuotePromotionDto, { code: ' summer20 ', planCode: 'MONTHLY' }).dto.code).toBe('SUMMER20');
    expect(run(QuotePromotionDto, { code: '1$', planCode: 'MONTHLY' }).failed).toEqual(['code']);
    expect(run(QuotePromotionDto, { code: 'SUMMER20' }).failed).toEqual(['planCode']);
    expect(run(QuotePromotionDto, { code: 'SUMMER20', planCode: 'MONTHLY', extra: 1 }).failed).toEqual(['extra']);
  });
  it('caps maxRedemptions', () => {
    const base = { code: 'SUMMER20', label: 'Summer', kind: 'PERCENTAGE', value: 10, startsOn: '2026-11-01', endsOn: '2026-11-30' };
    expect(run(CreatePromotionDto, { ...base, maxRedemptions: 100_001 }).failed).toEqual(['maxRedemptions']);
  });
});

describe('plans', () => {
  const base = { code: 'MONTHLY', kind: 'TERM', priceCentavos: 100 };
  it('refuses a blank name and turns a blank description into null', () => {
    expect(run(CreatePlanDto, { ...base, name: '   ' }).failed).toEqual(['name']);
    expect(run(UpdatePlanDto, { name: '  ' }).failed).toEqual(['name']);
    expect(run(UpdatePlanDto, { description: '  ' }).dto.description).toBeNull();
  });
});

describe('members (admin create/edit, import)', () => {
  const base = { firstName: 'Juan', lastName: 'Dela Cruz', email: 'JUAN@x.com ' };
  it('applies the name rule and 60-character cap to everyone', () => {
    expect(run(CreateMemberDto, { ...base, firstName: 'Juan2' }).failed).toEqual(['firstName']);
    expect(run(CreateMemberDto, { ...base, lastName: 'a'.repeat(61) }).failed).toEqual(['lastName']);
    expect(run(UpdateMemberDto, { firstName: '   ' }).failed).toEqual(['firstName']);
  });
  it('normalises phones, and lets an edit clear one', () => {
    expect(run(CreateMemberDto, { ...base, phone: '+63 917 123 4567' }).dto.phone).toBe('+639171234567');
    expect(run(CreateMemberDto, { ...base, phone: '02 8123 4567' }).failed).toEqual(['phone']);
    expect(run(UpdateMemberDto, { phone: '' }).dto.phone).toBeNull();
    expect(run(UpdateMemberDto, { phone: null }).failed).toEqual([]);
  });
  it('turns a blank emergency contact into null', () => {
    expect(run(UpdateMemberDto, { emergencyContact: '  ' }).dto.emergencyContact).toBeNull();
    expect(run(CreateMemberDto, { ...base, emergencyContact: '' }).dto.emergencyContact).toBeNull();
  });
  it('import rows: email trimmed and lower-cased, names and phone by the shared rules', () => {
    const row = { firstName: 'Ana', lastName: 'Cruz', planCode: 'MONTHLY', startsOn: '2026-01-01', endsOn: '2026-02-01', joinedOn: '2026-01-01' };
    expect(run(ImportMemberRowDto, { ...row, email: ' Ana@X.com ' }).dto.email).toBe('ana@x.com');
    expect(run(ImportMemberRowDto, { ...row, email: `${'a'.repeat(250)}@x.com` }).failed).toContain('email');
    expect(run(ImportMemberRowDto, { ...row, phone: '09171234567' }).dto.phone).toBe('+639171234567');
    expect(run(ImportMemberRowDto, { ...row, firstName: 'An4' }).failed).toEqual(['firstName']);
  });
});

describe('member join: date of birth', () => {
  const token = 'a'.repeat(20);
  it('refuses a future date and one before 1900, with no minimum age', () => {
    expect(run(AcceptMemberJoinDto, { token, dateOfBirth: '2999-01-01' }).failed).toEqual(['dateOfBirth']);
    expect(run(AcceptMemberJoinDto, { token, dateOfBirth: '1899-12-31' }).failed).toEqual(['dateOfBirth']);
    expect(run(AcceptMemberJoinDto, { token, dateOfBirth: '2020-02-30' }).failed).toEqual(['dateOfBirth']);
    expect(run(AcceptMemberJoinDto, { token, dateOfBirth: '2020-06-01' }).failed).toEqual([]);
  });
  it('treats "today" generously (UTC+14) so no zone refuses a real birthday', () => {
    expect(latestToday(Date.parse('2026-10-23T12:00:00Z'))).toBe('2026-10-24');
  });
});

describe('announcement cover image', () => {
  it('must be an https URL', () => {
    const base = { title: 'Hello', content: 'World' };
    expect(run(CreateAnnouncementDto, { ...base, coverImageUrl: 'javascript:alert(1)' }).failed).toContain('coverImageUrl');
    expect(run(CreateAnnouncementDto, { ...base, coverImageUrl: 'http://x.supabase.co/a.jpg' }).failed).toContain('coverImageUrl');
    expect(run(CreateAnnouncementDto, { ...base, coverImageUrl: 'https://x.supabase.co/a.jpg' }).failed).not.toContain('coverImageUrl');
  });
});

describe('shift note', () => {
  it('is trimmed', () => {
    expect(run(CloseShiftDto, { countedCentavos: 0, note: '  ok  ' }).dto.note).toBe('ok');
  });
});
