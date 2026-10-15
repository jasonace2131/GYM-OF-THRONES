import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { ApiSuccessResponse } from '@got/shared';

/**
 * Wraps all successful controller responses in the standard ApiSuccessResponse shape.
 * Controllers return plain data; this interceptor adds the success envelope.
 *
 * Before: { id: '1', name: 'John' }
 * After:  { success: true, data: { id: '1', name: 'John' } }
 */
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiSuccessResponse<T>> {
  intercept(_context: ExecutionContext, next: CallHandler<T>): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(
      map((data) => ({
        success: true as const,
        data,
      })),
    );
  }
}
