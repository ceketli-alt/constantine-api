/**
 * Ortak tipler + util'ler — 3 app de import edebilir.
 */
import { z } from 'zod';

export const idSchema = z.string().uuid();

export function isoNowUtc(): string {
  return new Date().toISOString();
}

/** Hono error wrapper — uniform 4xx/5xx response */
export function httpError(status: number, code: string, message: string, extras?: Record<string, unknown>) {
  return { error: { status, code, message, ...extras } };
}

export type ApiResult<T> = { data: T } | { error: ReturnType<typeof httpError>['error'] };
