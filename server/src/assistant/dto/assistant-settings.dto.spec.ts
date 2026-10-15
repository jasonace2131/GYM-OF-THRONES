import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SaveAssistantInstructionsDto, TryAssistantDraftDto } from './assistant-settings.dto';

/** Validated with the global pipe's own options, so an extra key fails here as it would 400. */
function constraints(cls: new () => object, payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap((error) =>
    Object.keys(error.constraints ?? {}),
  );
}

describe('SaveAssistantInstructionsDto', () => {
  it('accepts instructions and trims them', () => {
    const dto = plainToInstance(SaveAssistantInstructionsDto, { instructions: '  Be brief.\n' });
    expect(dto.instructions).toBe('Be brief.');
    expect(constraints(SaveAssistantInstructionsDto, { instructions: '  Be brief.\n' })).toEqual(
      [],
    );
  });

  it('rejects blank instructions, tabs and line breaks included', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: ' \t\r\n ' })).toContain(
      'isCodePointLength',
    );
  });

  it('accepts 6,000 characters and rejects 6,001', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: 'a'.repeat(6000) })).toEqual(
      [],
    );
    expect(constraints(SaveAssistantInstructionsDto, { instructions: 'a'.repeat(6001) })).toContain(
      'isCodePointLength',
    );
  });

  /** Postgres char_length and the editor's counter both count an emoji as one. */
  it('counts an emoji as one character, as the database does', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: '💪'.repeat(6000) })).toEqual(
      [],
    );
    expect(
      constraints(SaveAssistantInstructionsDto, { instructions: '💪'.repeat(6001) }),
    ).toContain('isCodePointLength');
  });

  /**
   * validator.js isLength also drops variation selectors, so it counted "❤️"
   * (U+2764 U+FE0F) as one where Postgres counts two — the DTO passed what the
   * CHECK then rejected as a 500.
   */
  it('counts a variation selector as Postgres does', () => {
    expect(constraints(SaveAssistantInstructionsDto, { instructions: '❤️'.repeat(3000) })).toEqual(
      [],
    );
    expect(
      constraints(SaveAssistantInstructionsDto, { instructions: '❤️'.repeat(3001) }),
    ).toContain('isCodePointLength');
    expect(
      constraints(TryAssistantDraftDto, { instructions: '❤️'.repeat(3001), question: 'Hi?' }),
    ).toContain('isCodePointLength');
  });

  it('names the field and the limit in the message', () => {
    const dto = plainToInstance(SaveAssistantInstructionsDto, { instructions: '' });
    const [error] = validateSync(dto);
    expect(error?.constraints?.['isCodePointLength']).toBe(
      'instructions must be 1–6000 characters',
    );
  });

  // A missing field only: the global pipe runs enableImplicitConversion, so a
  // number arrives as its string form and is not a type error at this layer.
  it('rejects a missing field', () => {
    expect(constraints(SaveAssistantInstructionsDto, {})).toContain('isString');
  });

  it('rejects unknown keys', () => {
    expect(
      constraints(SaveAssistantInstructionsDto, { instructions: 'Be brief.', isDefault: true }),
    ).toContain('whitelistValidation');
  });
});

describe('TryAssistantDraftDto', () => {
  it('accepts a draft and a question, trimmed', () => {
    const dto = plainToInstance(TryAssistantDraftDto, {
      instructions: ' Be brief. ',
      question: ' When do you open? ',
    });
    expect(dto).toMatchObject({ instructions: 'Be brief.', question: 'When do you open?' });
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'Be brief.', question: 'Hi?' }),
    ).toEqual([]);
  });

  it('holds the draft to the same 6,000-character limit as a save', () => {
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'a'.repeat(6001), question: 'Hi?' }),
    ).toContain('isCodePointLength');
  });

  it('rejects a blank question and one over 2,000 characters', () => {
    expect(constraints(TryAssistantDraftDto, { instructions: 'x', question: '   ' })).toContain(
      'isCodePointLength',
    );
    expect(
      constraints(TryAssistantDraftDto, { instructions: 'x', question: 'q'.repeat(2001) }),
    ).toContain('isCodePointLength');
  });
});
