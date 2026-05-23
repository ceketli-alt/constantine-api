/**
 * @api/ibrahim — İbrahim Acente Bakiye Sistemi backend
 * Port: 4002
 * DB: ibrahim_acente (Postgres 16, localhost)
 *
 * Eski Supabase'in karşılığı:
 *   - auth.users      → public.users (kendi tablomuz)
 *   - RLS policies    → middleware/authz.ts
 *   - .from(...)      → Hono routes + drizzle
 *   - Realtime        → frontend polling (react-query refetchInterval)
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { makeDb } from '@api/db';

const PORT = Number(process.env.PORT ?? 4002);
const DATABASE_URL = process.env.DATABASE_URL!;
const JWT_SECRET = process.env.JWT_SECRET ?? '';
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map(s => s.trim());

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET .env\'de yok ya da çok kısa (>=32 char gerekli)');
  process.exit(1);
}

const { db, client } = makeDb(DATABASE_URL);

const app = new Hono();

app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: (origin) => (CORS_ORIGINS.includes(origin) || CORS_ORIGINS.includes('*') ? origin : null),
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 600,
}));

// Health check — sıhhat probu
app.get('/health', async (c) => {
  try {
    const rows = await client`SELECT now() AS server_time, current_database() AS db, version()`;
    return c.json({
      status: 'ok',
      app: 'ibrahim',
      db: rows[0]?.db,
      server_time: rows[0]?.server_time,
      version: String(rows[0]?.version).split(',')[0],
    });
  } catch (e: any) {
    return c.json({ status: 'error', message: e.message }, 503);
  }
});

// TODO (Faz 2): Auth routes
//   POST /auth/login
//   POST /auth/refresh
//   POST /auth/logout

// TODO (Faz 3): Agent routes — RLS karşılığı authz middleware ile
//   GET    /agents          (authenticated)
//   POST   /agents          (authenticated)
//   PATCH  /agents/:id      (authenticated)
//   GET    /public/:slug    (anon — sadece archived=false)

// TODO (Faz 4): Movement routes
//   GET    /movements?agent_id=...
//   POST   /movements
//   PATCH  /movements/:id
//   DELETE /movements/:id

app.notFound((c) => c.json({ error: { status: 404, code: 'not_found', message: 'Bulunamadı' } }, 404));
app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ error: { status: 500, code: 'internal_error', message: err.message } }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, ({ port, address }) => {
  console.log(`✓ @api/ibrahim ${address}:${port}'da dinliyor`);
  console.log(`  Health: http://${address}:${port}/health`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM aldı, kapanıyor...');
  await client.end();
  process.exit(0);
});
