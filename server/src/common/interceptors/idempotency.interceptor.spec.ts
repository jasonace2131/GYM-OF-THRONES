import { BadRequestException, HttpStatus } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { PrismaService } from '../../prisma/prisma.service';
import { DomainException } from '../exceptions/domain.exception';
import { hashRequestBody } from '../idempotency/request-hash';
import { IdempotencyInterceptor } from './idempotency.interceptor';

const KEY = '11111111-2222-4333-8444-555555555555';
const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const BODY = { netCentavos: 80000 };

interface Harness {
  ctx: ExecutionContext;
  response: { status: jest.Mock };
}

function contextFor(
  headers: Record<string, string>,
  body: unknown = BODY,
  options: { originalUrl?: string; routePath?: string; user?: { id: string } } = {},
): Harness {
  const response = { status: jest.fn() };
  const request = {
    method: 'POST',
    path: '/payments',
    route: { path: options.routePath ?? '/payments' },
    originalUrl: options.originalUrl ?? '/payments',
    headers,
    body,
    user: options.user ?? USER,
  };
  return {
    ctx: {
      switchToHttp: () => ({ getRequest: () => request, getResponse: () => response }),
      getHandler: () => (): void => undefined,
      getClass: () => class {},
    } as unknown as ExecutionContext,
    response,
  };
}

describe('IdempotencyInterceptor', () => {
  let interceptor: IdempotencyInterceptor;
  let createMany: jest.Mock;
  let findUniqueOrThrow: jest.Mock;
  let update: jest.Mock;
  let deleteMany: jest.Mock;
  let next: CallHandler;

  beforeEach(() => {
    createMany = jest.fn().mockResolvedValue({ count: 1 });
    findUniqueOrThrow = jest.fn();
    update = jest.fn().mockResolvedValue({});
    deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    next = { handle: () => of({ success: true, data: { receiptNo: 1 } }) };

    const reflector = {
      getAllAndOverride: () => true,
      get: () => undefined,
    } as unknown as Reflector;

    interceptor = new IdempotencyInterceptor(reflector, {
      idempotencyRecord: { createMany, findUniqueOrThrow, update, deleteMany },
    } as unknown as PrismaService);
  });

  it('400s when the header is missing', async () => {
    const { ctx } = contextFor({});
    await expect(interceptor.intercept(ctx, next)).rejects.toThrow(BadRequestException);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('400s when the header is not a UUID', async () => {
    const { ctx } = contextFor({ 'idempotency-key': 'not-a-uuid' });
    await expect(interceptor.intercept(ctx, next)).rejects.toThrow(BadRequestException);
  });

  it('claims the key with skipDuplicates and stores the response', async () => {
    const { ctx } = contextFor({ 'idempotency-key': KEY });

    const result = await lastValueFrom(await interceptor.intercept(ctx, next));

    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(result).toEqual({ success: true, data: { receiptNo: 1 } });
    expect(update).toHaveBeenCalledWith({
      where: { key: KEY },
      data: {
        responseStatus: HttpStatus.CREATED,
        responseBody: { success: true, data: { receiptNo: 1 } },
      },
    });
  });

  it('replays the stored body at 200 when the hash matches', async () => {
    createMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({
      key: KEY,
      userId: USER.id,
      endpoint: 'POST /payments',
      requestHash: hashRequestBody(BODY),
      responseStatus: 201,
      responseBody: { success: true, data: { receiptNo: 1 } },
    });
    const { ctx, response } = contextFor({ 'idempotency-key': KEY });
    const handle = jest.fn();

    const result = await lastValueFrom(await interceptor.intercept(ctx, { handle }));

    expect(handle).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(HttpStatus.OK);
    expect(result).toEqual({ success: true, data: { receiptNo: 1 } });
  });

  it('409s IDEMPOTENCY_KEY_REUSED when the same key carries a different body', async () => {
    createMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({
      key: KEY,
      userId: USER.id,
      endpoint: 'POST /payments',
      requestHash: hashRequestBody({ netCentavos: 1 }),
      responseStatus: 201,
      responseBody: { success: true, data: { receiptNo: 1 } },
    });
    const { ctx } = contextFor({ 'idempotency-key': KEY });

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
      status: HttpStatus.CONFLICT,
    });
  });

  it('409s when the same key is replayed against a different endpoint', async () => {
    createMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({
      key: KEY,
      userId: USER.id,
      endpoint: 'POST /memberships',
      requestHash: hashRequestBody(BODY),
      responseStatus: 201,
      responseBody: { success: true, data: {} },
    });
    const { ctx } = contextFor({ 'idempotency-key': KEY });

    await expect(interceptor.intercept(ctx, next)).rejects.toBeInstanceOf(DomainException);
  });

  it('409s when the same key, same body, is replayed against a different :id in the concrete URL', async () => {
    // The stored identity must be keyed off the concrete path, not the route
    // pattern — otherwise POST /memberships/A/renew and POST
    // /memberships/B/renew with an identical (small/empty) body collide on
    // one key, and the second caller gets the first caller's stored receipt.
    createMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({
      key: KEY,
      userId: USER.id,
      endpoint: 'POST /memberships/aaaaaaaa-0000-4000-8000-000000000001/renew',
      requestHash: hashRequestBody(BODY),
      responseStatus: 201,
      responseBody: { success: true, data: { receiptNo: 1 } },
    });
    const { ctx } = contextFor({ 'idempotency-key': KEY }, BODY, {
      routePath: '/memberships/:id/renew',
      originalUrl: '/memberships/bbbbbbbb-0000-4000-8000-000000000002/renew',
    });

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
      status: HttpStatus.CONFLICT,
    });
  });

  it('409s, not replays, when the same key/endpoint/hash was claimed by a different caller', async () => {
    // stored.userId is written but was never compared — a different
    // authenticated caller presenting the same key, endpoint and body used
    // to receive the FIRST caller's stored response body verbatim, which for
    // a payment is a receipt naming someone else's member and amount.
    createMany.mockResolvedValue({ count: 0 });
    findUniqueOrThrow.mockResolvedValue({
      key: KEY,
      userId: USER.id,
      endpoint: 'POST /payments',
      requestHash: hashRequestBody(BODY),
      responseStatus: 201,
      responseBody: { success: true, data: { receiptNo: 1 } },
    });
    const { ctx } = contextFor({ 'idempotency-key': KEY }, BODY, {
      user: { id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' },
    });

    await expect(interceptor.intercept(ctx, next)).rejects.toMatchObject({
      response: { code: 'IDEMPOTENCY_KEY_REUSED' },
      status: HttpStatus.CONFLICT,
    });
  });

  it('releases the claim when the handler throws, so a retry is not blocked', async () => {
    const failing: CallHandler = {
      handle: () => {
        throw new Error('boom');
      },
    };
    const { ctx } = contextFor({ 'idempotency-key': KEY });

    await expect(lastValueFrom(await interceptor.intercept(ctx, failing))).rejects.toThrow('boom');
    expect(deleteMany).toHaveBeenCalledWith({ where: { key: KEY, responseStatus: 0 } });
  });

  it('does NOT release the claim when the handler succeeds but persisting the receipt fails', async () => {
    // The handler already ran to completion (e.g. charged a member) by the
    // time `update` is called. Releasing the claim here would let a retry
    // run the handler again and double-charge — strictly worse than a stuck
    // claim a human has to clear by hand. See the interceptor's class doc.
    update.mockRejectedValue(new Error('pooler connection reset'));
    const { ctx } = contextFor({ 'idempotency-key': KEY });

    await expect(lastValueFrom(await interceptor.intercept(ctx, next))).rejects.toThrow(
      'pooler connection reset',
    );
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('passes a route without @Idempotent() straight through', async () => {
    const reflector = {
      getAllAndOverride: () => false,
      get: () => undefined,
    } as unknown as Reflector;
    const plain = new IdempotencyInterceptor(reflector, {} as unknown as PrismaService);
    const { ctx } = contextFor({});

    await expect(lastValueFrom(await plain.intercept(ctx, next))).resolves.toEqual({
      success: true,
      data: { receiptNo: 1 },
    });
  });
});
