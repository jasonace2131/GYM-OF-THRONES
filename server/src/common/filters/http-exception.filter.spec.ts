import { ArgumentsHost, BadRequestException, ForbiddenException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainException } from '../exceptions/domain.exception';
import { HttpExceptionFilter } from './http-exception.filter';

interface Captured {
  host: ArgumentsHost;
  status: jest.Mock;
  json: jest.Mock;
}

function captureHost(): Captured {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/api/v1/coach-assignments' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders a DomainException with its own code at its own status', () => {
    const { host, status, json } = captureHost();

    filter.catch(
      new DomainException('COACH_SELF_ASSIGNMENT', 'A coach cannot be assigned to themselves'),
      host,
    );

    expect(status).toHaveBeenCalledWith(422);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: {
        code: 'COACH_SELF_ASSIGNMENT',
        message: 'A coach cannot be assigned to themselves',
      },
    });
  });

  it('still renders HTTP_400 for a ValidationPipe failure', () => {
    const { host, status, json } = captureHost();

    // This is the exact shape ValidationPipe throws: { statusCode, message[], error }
    filter.catch(new BadRequestException(['stationToken must be a string']), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'HTTP_400', message: 'stationToken must be a string' },
    });
  });

  it('still renders HTTP_403 for a plain Nest exception', () => {
    const { host, status, json } = captureHost();

    filter.catch(new ForbiddenException('Account is not active'), host);

    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'HTTP_403', message: 'Account is not active' },
    });
  });

  it('maps a known Prisma constraint violation to a 422 with its domain code', () => {
    const { host, status, json } = captureHost();

    filter.catch(
      new Prisma.PrismaClientKnownRequestError('constraint violated', {
        code: 'P2010',
        clientVersion: '6.19.0',
        meta: { constraint: 'CoachAssignment_not_self' },
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(422);
    expect(json.mock.calls[0]?.[0]).toMatchObject({
      success: false,
      error: { code: 'COACH_SELF_ASSIGNMENT' },
    });
  });

  it('renders an unmapped throw as a bare INTERNAL_SERVER_ERROR and logs it', () => {
    const { host, status, json } = captureHost();
    const logged = jest.spyOn(Logger.prototype, 'error');

    filter.catch(new Error('connection reset by peer'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      success: false,
      error: { code: 'INTERNAL_SERVER_ERROR', message: 'Internal server error' },
    });
    // The internal detail is logged, never leaked.
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(json.mock.calls[0])).not.toContain('connection reset');
  });

  it('renders an unmapped Prisma error as a 500, not a 422', () => {
    const { host, status } = captureHost();

    filter.catch(
      new Prisma.PrismaClientKnownRequestError('constraint violated', {
        code: 'P2010',
        clientVersion: '6.19.0',
        meta: { constraint: 'Some_Unmapped_constraint' },
      }),
      host,
    );

    expect(status).toHaveBeenCalledWith(500);
  });
});
