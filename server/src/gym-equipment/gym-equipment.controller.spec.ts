import 'reflect-metadata';
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AdminEquipmentController } from './gym-equipment.controller';
import { GymEquipmentDto, ReorderGymEquipmentDto } from './dto/gym-equipment.dto';
import type { GymEquipmentService } from './gym-equipment.service';

const ADMIN = { id: '11111111-1111-4111-8111-111111111111', role: 'ADMIN' } as AuthUser;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('AdminEquipmentController', () => {
  const handler = (name: string): object =>
    (AdminEquipmentController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));

  it('serves list, create, update, remove and reorder under /admin/equipment', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AdminEquipmentController)).toBe('admin/equipment');
    expect(meta(METHOD_METADATA, 'list')).toBe(RequestMethod.GET);
    expect(meta(METHOD_METADATA, 'create')).toBe(RequestMethod.POST);
    expect(meta(METHOD_METADATA, 'update')).toBe(RequestMethod.PATCH);
    expect(meta(PATH_METADATA, 'update')).toBe(':id');
    expect(meta(METHOD_METADATA, 'remove')).toBe(RequestMethod.DELETE);
    expect(meta(METHOD_METADATA, 'reorder')).toBe(RequestMethod.PUT);
    expect(meta(PATH_METADATA, 'reorder')).toBe('order');
  });

  /** The Settings key that already governs what the AI is told. */
  it('gates every route on ai.admin.configure', () => {
    for (const name of ['list', 'create', 'update', 'remove', 'reorder']) {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBe('ai.admin.configure');
    }
  });

  it('makes create idempotent, so a double tap adds one row', () => {
    expect(meta(IDEMPOTENT_KEY, 'create')).toBe(true);
  });

  it('passes the caller through to the service', async () => {
    const service = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: A }),
      update: jest.fn().mockResolvedValue({ id: A }),
      remove: jest.fn().mockResolvedValue(undefined),
      reorder: jest.fn().mockResolvedValue([]),
    };
    const controller = new AdminEquipmentController(service as unknown as GymEquipmentService);
    await controller.create(ADMIN, { name: 'Bench' });
    expect(service.create).toHaveBeenCalledWith({ name: 'Bench' }, ADMIN.id, 'ADMIN');
    await controller.update(ADMIN, A, { name: 'Bench', detail: null });
    expect(service.update).toHaveBeenCalledWith(A, { name: 'Bench', detail: null }, ADMIN.id, 'ADMIN');
    await expect(controller.remove(ADMIN, A)).resolves.toEqual({ removed: true });
    await controller.reorder(ADMIN, { ids: [A] });
    expect(service.reorder).toHaveBeenCalledWith([A], ADMIN.id, 'ADMIN');
  });

  describe('DTOs', () => {
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    const validate = (metatype: new () => object, value: unknown) =>
      pipe.transform(value, { type: 'body', metatype });

    it('trims and bounds the name and detail', async () => {
      await expect(validate(GymEquipmentDto, { name: '  Bench ', detail: ' 2 kg ' })).resolves.toMatchObject({
        name: 'Bench',
        detail: '2 kg',
      });
      await expect(validate(GymEquipmentDto, { name: '   ' })).rejects.toBeDefined();
      await expect(validate(GymEquipmentDto, { name: 'x'.repeat(81) })).rejects.toBeDefined();
      await expect(
        validate(GymEquipmentDto, { name: 'Bench', detail: 'x'.repeat(121) }),
      ).rejects.toBeDefined();
      await expect(validate(GymEquipmentDto, { name: 'Bench', detail: null })).resolves.toBeDefined();
      await expect(validate(GymEquipmentDto, { name: 'Bench', extra: 1 })).rejects.toBeDefined();
    });

    it('needs a list of uuids to reorder', async () => {
      await expect(validate(ReorderGymEquipmentDto, { ids: [A] })).resolves.toBeDefined();
      await expect(validate(ReorderGymEquipmentDto, { ids: ['nope'] })).rejects.toBeDefined();
      await expect(validate(ReorderGymEquipmentDto, {})).rejects.toBeDefined();
    });
  });
});
