import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateAnnouncementDto } from './create-announcement.dto';
import { SignAnnouncementUploadDto } from './sign-announcement-upload.dto';
import { UpdateAnnouncementDto } from './update-announcement.dto';

/**
 * Validated with the global pipe's own options — `whitelist` plus
 * `forbidNonWhitelisted`, and implicit conversion — so what passes here passes
 * at the edge.
 */
function check<T extends object>(
  cls: ClassConstructor<T>,
  payload: Record<string, unknown>,
): { dto: T; failed: string[] } {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  const failed = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
    (error) => error.property,
  );
  return { dto, failed };
}

const DOC = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }],
};

describe('CreateAnnouncementDto', () => {
  it('accepts a plain notice, exactly as before', () => {
    expect(check(CreateAnnouncementDto, { title: 'Hours', content: 'Open late' }).failed).toEqual(
      [],
    );
  });

  it('accepts a rich notice with no plain content', () => {
    const { dto, failed } = check(CreateAnnouncementDto, { title: 'Hours', contentJson: DOC });
    expect(failed).toEqual([]);
    expect(dto.contentJson).toEqual(DOC);
  });

  it('requires one body or the other', () => {
    expect(check(CreateAnnouncementDto, { title: 'Hours' }).failed).toContain('content');
  });

  it.each([
    ['null', null],
    ['an array', [DOC]],
    ['a string', '<p>hi</p>'],
  ])('refuses contentJson as %s', (_label, contentJson) => {
    expect(check(CreateAnnouncementDto, { title: 'Hours', contentJson }).failed).toContain(
      'contentJson',
    );
  });

  it('accepts a null or absent cover, and keeps null as null', () => {
    expect(check(CreateAnnouncementDto, { title: 'H', content: 'x' }).failed).toEqual([]);
    const { dto, failed } = check(CreateAnnouncementDto, {
      title: 'H',
      content: 'x',
      coverImageUrl: null,
    });
    expect(failed).toEqual([]);
    expect(dto.coverImageUrl).toBeNull();
  });

  it('refuses a cover that is not a string, or absurdly long', () => {
    expect(
      check(CreateAnnouncementDto, { title: 'H', content: 'x', coverImageUrl: 7 }).failed,
    ).toContain('coverImageUrl');
    expect(
      check(CreateAnnouncementDto, {
        title: 'H',
        content: 'x',
        coverImageUrl: `https://x/${'a'.repeat(2100)}`,
      }).failed,
    ).toContain('coverImageUrl');
  });

  it('still forbids unknown keys — contentHtml is not a way in', () => {
    expect(
      check(CreateAnnouncementDto, { title: 'H', content: 'x', contentHtml: '<script>' }).failed,
    ).toContain('contentHtml');
  });
});

describe('UpdateAnnouncementDto', () => {
  it('accepts an empty body as a no-op', () => {
    expect(check(UpdateAnnouncementDto, {}).failed).toEqual([]);
  });

  it('accepts contentJson alone and a null cover alone', () => {
    expect(check(UpdateAnnouncementDto, { contentJson: DOC }).failed).toEqual([]);
    expect(check(UpdateAnnouncementDto, { coverImageUrl: null }).failed).toEqual([]);
  });

  it('refuses a null contentJson — send content to make a notice plain', () => {
    expect(check(UpdateAnnouncementDto, { contentJson: null }).failed).toContain('contentJson');
  });
});

describe('SignAnnouncementUploadDto', () => {
  it.each(['image/jpeg', 'image/png', 'image/webp'])('accepts %s', (contentType) => {
    expect(check(SignAnnouncementUploadDto, { contentType, size: 200_000 }).failed).toEqual([]);
  });

  it.each(['image/svg+xml', 'image/gif', 'text/html', 'application/pdf'])(
    'refuses %s',
    (contentType) => {
      expect(check(SignAnnouncementUploadDto, { contentType, size: 10 }).failed).toContain(
        'contentType',
      );
    },
  );

  it.each([0, -1, 5 * 1024 * 1024 + 1, 1.5])('refuses a size of %p', (size) => {
    expect(check(SignAnnouncementUploadDto, { contentType: 'image/webp', size }).failed).toContain(
      'size',
    );
  });

  it('refuses a caller-chosen path', () => {
    expect(
      check(SignAnnouncementUploadDto, {
        contentType: 'image/webp',
        size: 10,
        path: '../gcash-proofs/x.webp',
      }).failed,
    ).toContain('path');
  });
});
