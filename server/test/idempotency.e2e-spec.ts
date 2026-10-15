/* eslint-disable @typescript-eslint/no-unsafe-member-access --
   supertest types res.body as `any`; every e2e spec reads assertions off it. */
import { Body, Controller, Param, Post } from '@nestjs/common';
import { IsInt, Max, Min } from 'class-validator';
import request from 'supertest';
import { Idempotent } from '../src/common/decorators/idempotent.decorator';
import { resetDatabase } from './support/db';
import { createTestApp, type TestApp } from './support/test-app';
import { FIXTURE_IDS } from './support/auth-fixture';

const KEY = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

class ProbePaymentDto {
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  netCentavos!: number;
}

let handlerCalls = 0;

/** Stands in for chunk 1's POST /payments — chunk 0 ships no money write. */
@Controller('idempotency-probe')
class IdempotencyProbeController {
  @Post()
  @Idempotent()
  pay(@Body() dto: ProbePaymentDto): { receiptNo: number; netCentavos: number } {
    handlerCalls += 1;
    return { receiptNo: handlerCalls, netCentavos: dto.netCentavos };
  }
}

/** A second route, to prove one key cannot cross endpoints. */
@Controller('idempotency-probe-two')
class SecondProbeController {
  @Post()
  @Idempotent()
  pay(@Body() dto: ProbePaymentDto): { receiptNo: number; netCentavos: number } {
    handlerCalls += 1;
    return { receiptNo: handlerCalls, netCentavos: dto.netCentavos };
  }
}

/**
 * Stands in for chunk 1's POST /memberships/:id/renew — a route where the id
 * IS the target and the body is small enough to collide across two different
 * ids. Proves the identity is keyed off the concrete path, not the route
 * pattern shared by every `:id`.
 */
@Controller('idempotency-probe-with-id/:id')
class IdParamProbeController {
  @Post()
  @Idempotent()
  pay(
    @Param('id') id: string,
    @Body() dto: ProbePaymentDto,
  ): { id: string; receiptNo: number; netCentavos: number } {
    handlerCalls += 1;
    return { id, receiptNo: handlerCalls, netCentavos: dto.netCentavos };
  }
}

describe('idempotency contract (e2e)', () => {
  let ctx: TestApp;
  let token: string;

  const post = (path: string): request.Test =>
    request(ctx.app.getHttpServer()).post(path).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    ctx = await createTestApp({
      controllers: [IdempotencyProbeController, SecondProbeController, IdParamProbeController],
    });
    await resetDatabase(ctx.prisma);
    token = await ctx.fixture.tokenFor('FRONT_DESK');
  });

  beforeEach(async () => {
    handlerCalls = 0;
    await ctx.prisma.idempotencyRecord.deleteMany();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('400s a request with no Idempotency-Key', async () => {
    const res = await post('/api/v1/idempotency-probe').send({ netCentavos: 80000 }).expect(400);

    expect(res.body.error.message).toContain('Idempotency-Key');
    expect(handlerCalls).toBe(0);
  });

  it('400s a non-UUID Idempotency-Key', async () => {
    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', 'double-tap')
      .send({ netCentavos: 80000 })
      .expect(400);
  });

  it('stores the response on the first call and replays it byte-identically at 200', async () => {
    const first = await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);

    expect(first.body).toEqual({ success: true, data: { receiptNo: 1, netCentavos: 80000 } });

    const replay = await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(200);

    // A 201 replays as a 200, and the body is byte-identical — one envelope,
    // never two.
    expect(replay.body).toEqual(first.body);
    expect(handlerCalls).toBe(1);
    expect(await ctx.prisma.idempotencyRecord.count()).toBe(1);
  });

  it('is insensitive to key order in the replayed body', async () => {
    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);

    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .set('Content-Type', 'application/json')
      .send('{ "netCentavos": 80000 }')
      .expect(200);

    expect(handlerCalls).toBe(1);
  });

  it('409s IDEMPOTENCY_KEY_REUSED for the same key with a different body, writing nothing', async () => {
    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);

    const res = await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 90000 })
      .expect(409);

    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'IDEMPOTENCY_KEY_REUSED',
        message: 'This Idempotency-Key was already used for a different request',
      },
    });
    expect(handlerCalls).toBe(1);
    expect(await ctx.prisma.idempotencyRecord.count()).toBe(1);
  });

  it('scopes a record to one endpoint', async () => {
    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);

    const res = await post('/api/v1/idempotency-probe-two')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(409);

    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(handlerCalls).toBe(1);
  });

  it('records the endpoint, the caller and a 64-character hash', async () => {
    await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);

    const stored = await ctx.prisma.idempotencyRecord.findUniqueOrThrow({ where: { key: KEY } });

    expect(stored.endpoint).toBe('POST /api/v1/idempotency-probe');
    expect(stored.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.responseStatus).toBe(201);
    expect(stored.userId).toBe(await ctx.fixture.userIdFor('10000000-0000-4000-8000-000000000002'));
  });

  it('409s the same key/body replayed against a different :id, instead of replaying the first receipt', async () => {
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';

    const first = await post(`/api/v1/idempotency-probe-with-id/${idA}`)
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);
    expect(first.body.data).toEqual({ id: idA, receiptNo: 1, netCentavos: 80000 });

    // Same key, same body, different :id — the pattern
    // /idempotency-probe-with-id/:id is identical for both requests, so a
    // route-pattern-keyed identity would wrongly treat this as a replay and
    // hand back idA's receipt as if idB had also been processed.
    const second = await post(`/api/v1/idempotency-probe-with-id/${idB}`)
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(409);

    expect(second.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(handlerCalls).toBe(1);
  });

  it('409s IDEMPOTENCY_KEY_REUSED, not a replay, when a different caller presents the same key/endpoint/body', async () => {
    const otherToken = await ctx.fixture.tokenFor('COACH', { supabaseId: FIXTURE_IDS.COACH_A });

    const first = await post('/api/v1/idempotency-probe')
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(201);
    expect(first.body.data).toEqual({ receiptNo: 1, netCentavos: 80000 });

    // `key` is the global primary key: without an owner check, a different
    // authenticated caller presenting the exact same key/endpoint/body used
    // to receive the FIRST caller's stored receipt verbatim.
    const res = await request(ctx.app.getHttpServer())
      .post('/api/v1/idempotency-probe')
      .set('Authorization', `Bearer ${otherToken}`)
      .set('Idempotency-Key', KEY)
      .send({ netCentavos: 80000 })
      .expect(409);

    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(handlerCalls).toBe(1);
  });
});
