/**
 * Shared DB factory — her app kendi bağlantısını alır.
 * Tek `postgres` client'tan, drizzle ile sarmalanmış 3 ayrı export.
 */
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';

export function makeDb(url: string, opts?: { max?: number; prepare?: boolean }) {
  if (!url) throw new Error('DATABASE_URL boş — .env kontrol et');
  const client = postgres(url, {
    max: opts?.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 10,
    prepare: opts?.prepare ?? false, // Supabase parite için (RLS bypass yok, basit query'ler)
  });
  return { client, db: drizzle(client) };
}

export type DbHandle = ReturnType<typeof makeDb>;
