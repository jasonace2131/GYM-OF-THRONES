import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PAGINATION_DEFAULTS } from '@got/shared';
import { PaginationQueryDto } from './pagination-query.dto';
import { paginated, paginationSkipTake } from './paginate';

/** Mirrors the global ValidationPipe's transform options exactly. */
function parse(query: Record<string, unknown>): {
  dto: PaginationQueryDto;
  errors: ReturnType<typeof validateSync>;
} {
  const dto = plainToInstance(PaginationQueryDto, query, { enableImplicitConversion: true });
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }) };
}

describe('PaginationQueryDto', () => {
  it('applies the shared defaults when nothing is supplied', () => {
    const { dto, errors } = parse({});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(PAGINATION_DEFAULTS.PAGE);
    expect(dto.limit).toBe(PAGINATION_DEFAULTS.LIMIT);
  });

  it('coerces the query string numbers the URL actually carries', () => {
    const { dto, errors } = parse({ page: '3', limit: '25' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.limit).toBe(25);
  });

  it('rejects a non-numeric page', () => {
    const { errors } = parse({ page: 'abc' });
    expect(errors).toHaveLength(1);
    expect(errors[0].property).toBe('page');
  });

  it('rejects page 0', () => {
    const { errors } = parse({ page: 0 });
    expect(errors.map((e) => e.property)).toEqual(['page']);
  });

  it('enforces MAX_LIMIT so one caller cannot ask for the whole table', () => {
    const { errors } = parse({ limit: PAGINATION_DEFAULTS.MAX_LIMIT + 1 });
    expect(errors.map((e) => e.property)).toEqual(['limit']);
  });

  it('accepts exactly MAX_LIMIT', () => {
    const { errors } = parse({ limit: PAGINATION_DEFAULTS.MAX_LIMIT });
    expect(errors).toHaveLength(0);
  });
});

describe('paginationSkipTake', () => {
  it('turns page 1 into a zero offset', () => {
    expect(paginationSkipTake({ page: 1, limit: 10 })).toEqual({ skip: 0, take: 10 });
  });

  it('offsets by whole pages', () => {
    expect(paginationSkipTake({ page: 4, limit: 25 })).toEqual({ skip: 75, take: 25 });
  });
});

describe('paginated', () => {
  it('builds the shared PaginatedData envelope', () => {
    expect(paginated(['a', 'b'], 42, { page: 2, limit: 10 })).toEqual({
      items: ['a', 'b'],
      total: 42,
      page: 2,
      limit: 10,
      totalPages: 5,
    });
  });

  it('reports one page for an empty result rather than zero', () => {
    expect(paginated([], 0, { page: 1, limit: 10 }).totalPages).toBe(1);
  });
});
