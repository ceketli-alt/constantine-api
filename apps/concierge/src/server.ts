/**
 * @api/concierge — Concierge Connect backend
 * Port: 4002
 * DB: concierge (Postgres 16, localhost)
 *
 * Supabase drop-in replacement:
 *   /rest/v1/:table  → PostgREST uyumlu CRUD
 *   /rpc/:fn         → Supabase RPC karşılığı (DB function çağrısı)
 *   /auth/v1/token   → password login
 *   /storage/v1/...  → (Faz 2: lokal disk + nginx)
 */
import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { sql, withRequestContext } from './db.js';
import { authnMiddleware, requireAuth } from './middleware.js';
import { handleRest } from './rest.js';
import { handleFunctionStub, listFunctions } from './functions-stub.js';
import { handleStorageProxy } from './storage-proxy.js';
import { handleGoogleOAuthCallback } from './google-oauth.js';
import { handleCalendarPull, handleCalendarPush } from './google-calendar.js';
import { sendTestEmail, sendEmail } from './resend-send.js';
import { handleNotificationsDispatch, startNotificationsRunner } from './notifications-dispatch.js';
import { handleStorefrontApi } from './storefront-api.js';
import { handleCcStripe } from './cc-stripe.js';
import {
  verifyAnyJWT,
  verifyRefreshToken,
  lookupUserByEmail,
  verifyPassword,
  issueAccessToken,
  issueRefreshToken,
  verifyAgainstLegacySupabase,
  hashPassword,
  setUserPassword,
} from './auth.js';
import {
  generateRecoveryToken,
  consumeRecoveryToken,
  sendRecoveryEmail,
} from './auth-recovery.js';

const PORT = Number(process.env.PORT ?? 4001);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim());
const API_PUBLIC_URL = process.env.API_PUBLIC_URL || 'https://api-cc.constantineyachts.com';
const SITE_URL_ADMIN = process.env.SITE_URL_ADMIN || 'https://cc-admin.constantineyachts.com';

const app = new Hono();
app.use('*', logger());
app.use('*', secureHeaders());
app.use('*', cors({
  origin: (origin) => (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin) ? (origin || '*') : null),
  allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
  allowHeaders: [
    'Content-Type', 'Authorization', 'apikey',
    'X-Client-Info', 'X-Supabase-Api-Version', 'X-Supabase-Auth',
    'Prefer', 'Range', 'Range-Unit',
    'accept-profile', 'content-profile',
  ],
  exposeHeaders: ['Content-Range'],
  credentials: true,
  maxAge: 600,
}));

// ─────────────────────────────────────────────────────────
// Health
// ─────────────────────────────────────────────────────────
app.get('/health', async (c) => {
  try {
    const rows = await sql`SELECT now() AS t, current_database() AS db, version() AS v`;
    return c.json({
      status: 'ok',
      app: 'concierge',
      db: rows[0]?.db,
      server_time: rows[0]?.t,
      version: String(rows[0]?.v).split(',')[0],
    });
  } catch (e: any) {
    return c.json({ status: 'error', message: e.message }, 503);
  }
});

// ─────────────────────────────────────────────────────────
// Authn middleware (her route'tan önce)
// ─────────────────────────────────────────────────────────
app.use('*', authnMiddleware);

// ─────────────────────────────────────────────────────────
// Auth endpoints — Supabase /auth/v1/* compat
// ─────────────────────────────────────────────────────────

// POST /auth/v1/token?grant_type=(password|refresh_token)
app.post('/auth/v1/token', async (c) => {
  const grant = c.req.query('grant_type');
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }

  // ---------- PASSWORD GRANT ----------
  if (grant === 'password') {
    const { email, password } = body ?? {};
    if (!email || !password) return c.json({ error: 'invalid_request', error_description: 'email + password gerekli' }, 400);
    const user = await lookupUserByEmail(String(email));
    if (!user) return c.json({ error: 'invalid_grant', error_description: 'Hesap bulunamadı' }, 400);
    if (!user.active) return c.json({ error: 'invalid_grant', error_description: 'Hesap pasif' }, 403);

    // 1. Lokal hash varsa ve argon2 ise → bizden verify
    let ok = false;
    if (user.password_hash && user.password_hash.startsWith('$argon2')) {
      ok = await verifyPassword(String(password), user.password_hash);
    }

    // 2. Lokal başarısızsa veya hash yoksa → Supabase'e fallback (transparent migration)
    if (!ok) {
      const supaOk = await verifyAgainstLegacySupabase(String(email), String(password));
      if (supaOk) {
        try {
          await setUserPassword(user.id, String(password));
          console.log(`[auth] Transparent migration: ${email} Supabase'den lokal'e taşındı`);
        } catch (e) {
          console.error(`[auth] Hash kaydetme hatası ${email}:`, (e as Error).message);
        }
        ok = true;
      }
    }

    if (!ok) return c.json({ error: 'invalid_grant', error_description: 'Şifre yanlış' }, 400);
    const session = { id: user.id, email: user.email, role: user.role ?? 'authenticated', active: user.active };
    const access_token = await issueAccessToken(session);
    const refresh_token = await issueRefreshToken(session);
    const rows = await sql`
      SELECT u.id, u.email, u.created_at, p.role::text AS role, p.active, p.full_name
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE u.id = ${user.id}
    `;
    return c.json({
      access_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token,
      user: rows[0] ? buildSupabaseUser(rows[0]) : { id: user.id, email: user.email },
    });
  }

  // ---------- REFRESH TOKEN GRANT ----------
  // Supabase JS client 1 saatte bir otomatik çağırır. Yoksa browser logout olur.
  if (grant === 'refresh_token') {
    const refreshTokenIn: string | undefined = body?.refresh_token;
    if (!refreshTokenIn) {
      return c.json({ error: 'invalid_request', error_description: 'refresh_token gerekli' }, 400);
    }
    let payload: { sub: string };
    try {
      payload = await verifyRefreshToken(refreshTokenIn);
    } catch (e: any) {
      return c.json({ error: 'invalid_grant', error_description: e?.message ?? 'Refresh token geçersiz' }, 400);
    }
    // User re-fetch: rol/aktiflik değişmiş olabilir (silent revoke)
    const rows = await sql`
      SELECT u.id, u.email, u.created_at, p.role::text AS role, p.active, p.full_name
      FROM auth.users u
      LEFT JOIN public.profiles p ON p.id = u.id
      WHERE u.id = ${payload.sub}
      LIMIT 1
    `;
    const userRow = rows[0] as any;
    if (!userRow) {
      return c.json({ error: 'invalid_grant', error_description: 'Hesap bulunamadı' }, 400);
    }
    if (userRow.active === false) {
      return c.json({ error: 'invalid_grant', error_description: 'Hesap pasif' }, 403);
    }
    const session = {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role ?? 'authenticated',
      active: userRow.active !== false,
    };
    const access_token = await issueAccessToken(session);
    const refresh_token = await issueRefreshToken(session); // rotating
    return c.json({
      access_token,
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token,
      user: buildSupabaseUser(userRow),
    });
  }

  return c.json({ error: 'unsupported_grant_type', error_description: `grant_type=${grant} desteklenmiyor` }, 400);
});

// POST /auth/v1/logout — frontend cookie temizler, biz no-op
app.post('/auth/v1/logout', (c) => c.body(null, 204));

// POST /auth/v1/recover — şifre sıfırlama maili tetikle
// Email enumeration koruması: kullanıcı bulunsa da bulunmasa da 200 dönüyoruz.
app.post('/auth/v1/recover', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({}, 200); }
  const email = body?.email;
  if (!email || typeof email !== 'string') return c.json({}, 200);

  try {
    const user = await lookupUserByEmail(email);
    if (user && user.active !== false) {
      const token = await generateRecoveryToken(user.id);
      const link =
        `${API_PUBLIC_URL}/auth/v1/verify` +
        `?token=${encodeURIComponent(token)}` +
        `&type=recovery` +
        `&redirect_to=${encodeURIComponent(`${SITE_URL_ADMIN}/reset-password`)}`;
      const mail = await sendRecoveryEmail(user.email, link);
      if (!mail.ok) {
        // Sessiz log — kullanıcıya 200 dönmeye devam (enum koruması)
        console.error('[recover] mail gönderilemedi', user.email, mail.error);
      }
    } else {
      console.log(`[recover] bilinmeyen veya pasif email: ${email}`);
    }
  } catch (e: any) {
    console.error('[recover] hata:', e.message);
  }
  return c.json({}, 200);
});

// GET /auth/v1/verify — recovery token doğrula + JWT mint + 302 redirect
// Mail içindeki link buraya gelir. Hash fragment'ta access/refresh token'ları veririz,
// Supabase JS client otomatik session restore eder.
app.get('/auth/v1/verify', async (c) => {
  const token = c.req.query('token');
  const type = c.req.query('type') ?? 'recovery';
  const redirectTo = c.req.query('redirect_to') || `${SITE_URL_ADMIN}/reset-password`;

  if (!token) {
    return c.redirect(`${redirectTo}?error=invalid_request`, 302);
  }
  const consumed = await consumeRecoveryToken(token);
  if (!consumed) {
    return c.redirect(`${redirectTo}?error=invalid_or_expired_token`, 302);
  }

  // Aktif user mu? (pasif hesap için login üretmeyiz)
  const userRows = await sql`
    SELECT u.id, u.email, p.role::text AS role, p.active
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = ${consumed.userId}
  `;
  const row = userRows[0] as any;
  if (!row || row.active === false) {
    return c.redirect(`${redirectTo}?error=user_disabled`, 302);
  }

  const session = {
    id: row.id,
    email: row.email,
    role: row.role ?? 'authenticated',
    active: row.active ?? true,
  };
  const access_token = await issueAccessToken(session);
  const refresh_token = await issueRefreshToken(session);

  // Supabase JS bekliyor: #access_token=...&refresh_token=...&type=recovery&token_type=bearer&expires_in=3600
  const hash =
    `access_token=${access_token}` +
    `&refresh_token=${refresh_token}` +
    `&expires_in=3600` +
    `&token_type=bearer` +
    `&type=${encodeURIComponent(type)}`;
  return c.redirect(`${redirectTo}#${hash}`, 302);
});

// POST /auth/v1/signup — yeni hesap aç (vendor veya reseller self-service)
app.post('/auth/v1/signup', async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }
  const { email, password, options } = body ?? {};
  if (!email || !password) return c.json({ error: 'invalid_request', error_description: 'email + password gerekli' }, 400);
  if (String(password).length < 8) return c.json({ error: 'weak_password', error_description: 'Şifre en az 8 karakter olmalı' }, 400);

  const fullName: string = options?.data?.full_name ?? '';
  const accountType: string = options?.data?.account_type ?? 'vendor';
  const role = accountType === 'reseller' ? 'reseller_admin' : 'vendor_owner';

  // Mevcut user kontrolü
  const existing = await lookupUserByEmail(String(email));
  if (existing) {
    return c.json({ error: 'user_already_exists', error_description: 'Bu email zaten kayıtlı' }, 400);
  }

  // 1. auth.users satırı oluştur (id auto-gen)
  const hash = await hashPassword(String(password));
  const inserted = await sql<{ id: string; created_at: string }[]>`
    INSERT INTO auth.users (email, password_hash, encrypted_password, email_confirmed_at)
    VALUES (${String(email).toLowerCase()}, ${hash}, '', now())
    RETURNING id, created_at
  `;
  const insertedRow = inserted[0];
  if (!insertedRow) {
    return c.json({ error: 'signup_failed', error_description: 'User insert dönüş satırı boş' }, 500);
  }
  const userId = insertedRow.id;

  // 2. public.profiles satırı oluştur (role enum cc_user_role)
  try {
    await sql`
      INSERT INTO public.profiles (id, email, full_name, role)
      VALUES (${userId}, ${String(email).toLowerCase()}, ${fullName}, ${role}::cc_user_role)
    `;
  } catch (e: any) {
    // Profile insert fail → auth.users'ı temizle (atomic değil ama best effort)
    await sql`DELETE FROM auth.users WHERE id = ${userId}`;
    console.error('[signup] profile insert failed:', e.message);
    return c.json({ error: 'signup_failed', error_description: e.message }, 400);
  }

  // 3. Session mint
  const sessionUser = { id: userId, email: String(email).toLowerCase(), role: 'authenticated', active: true };
  const access_token = await issueAccessToken(sessionUser);
  const refresh_token = await issueRefreshToken(sessionUser);

  const rows = await sql`
    SELECT u.id, u.email, u.created_at, p.role::text AS role, p.active, p.full_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = ${userId}
  `;

  return c.json({
    access_token,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token,
    user: rows[0] ? buildSupabaseUser(rows[0]) : { id: userId, email: String(email).toLowerCase() },
  });
});

// GET /auth/v1/user — current user (Bearer token)
function buildSupabaseUser(row: any) {
  const now = new Date().toISOString();
  return {
    id: row.id,
    aud: 'authenticated',
    role: 'authenticated', // Supabase auth.role'ü 'authenticated', bizim public.role ayrı
    email: row.email,
    email_confirmed_at: row.created_at ?? now,
    phone: '',
    confirmed_at: row.created_at ?? now,
    last_sign_in_at: now,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {
      email: row.email,
      email_verified: true,
      full_name: row.full_name ?? row.email,
      sub: row.id,
      phone_verified: false,
      role: row.role ?? 'crew', // public.role buraya
    },
    identities: [
      {
        id: row.id,
        user_id: row.id,
        identity_id: row.id,
        identity_data: { email: row.email, email_verified: true, sub: row.id },
        provider: 'email',
        created_at: row.created_at ?? now,
        last_sign_in_at: now,
        updated_at: now,
      },
    ],
    created_at: row.created_at ?? now,
    updated_at: now,
    is_anonymous: false,
  };
}

app.get('/auth/v1/user', async (c) => {
  const auth = requireAuth(c);
  if (!auth) return c.json({ message: 'Auth gerek', code: 'no_auth' }, 401);
  const rows = await sql`
    SELECT u.id, u.email, u.created_at, p.role::text AS role, p.active, p.full_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = ${auth.userId}
  `;
  if (!rows[0]) return c.json({ message: 'User bulunamadı', code: 'not_found' }, 404);
  return c.json(buildSupabaseUser(rows[0]));
});

// PUT /auth/v1/user — kendi şifre/email/metadata güncelleme
// Supabase JS supabase.auth.updateUser({...}) bu endpoint'e PUT atar.
app.put('/auth/v1/user', async (c) => {
  const auth = requireAuth(c);
  if (!auth) return c.json({ message: 'Auth gerek', code: 'no_auth' }, 401);

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_request' }, 400); }
  const { password, email, data } = body ?? {};

  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) {
      return c.json({ error: 'weak_password', error_description: 'Şifre en az 8 karakter olmalı' }, 400);
    }
    await setUserPassword(auth.userId, password);
  }

  if (email !== undefined && typeof email === 'string' && email.length > 0) {
    const lower = email.toLowerCase();
    // Başka kullanıcıda var mı kontrol
    const dup = await sql`SELECT id FROM auth.users WHERE lower(email) = ${lower} AND id <> ${auth.userId} LIMIT 1`;
    if (dup[0]) return c.json({ error: 'email_taken', error_description: 'Bu email başka bir hesapta kullanılıyor' }, 400);
    await sql`UPDATE auth.users SET email = ${lower}, updated_at = now() WHERE id = ${auth.userId}`;
    await sql`UPDATE public.profiles SET email = ${lower} WHERE id = ${auth.userId}`;
  }

  if (data !== undefined && typeof data === 'object' && data !== null) {
    // full_name destekle (Supabase user_metadata.full_name pattern'i)
    if (typeof (data as any).full_name === 'string') {
      await sql`UPDATE public.profiles SET full_name = ${(data as any).full_name} WHERE id = ${auth.userId}`;
    }
    // raw_user_meta_data jsonb — destek için merge
    await sql`
      UPDATE auth.users
      SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || ${sql.json(data)},
          updated_at = now()
      WHERE id = ${auth.userId}
    `;
  }

  const rows = await sql`
    SELECT u.id, u.email, u.created_at, p.role::text AS role, p.active, p.full_name
    FROM auth.users u
    LEFT JOIN public.profiles p ON p.id = u.id
    WHERE u.id = ${auth.userId}
  `;
  if (!rows[0]) return c.json({ message: 'User bulunamadı', code: 'not_found' }, 404);
  return c.json(buildSupabaseUser(rows[0]));
});

// ─────────────────────────────────────────────────────────
// /rest/v1/:table — Generic CRUD
// ─────────────────────────────────────────────────────────
const TABLE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

app.all('/rest/v1/:table', async (c) => {
  const table = c.req.param('table');
  if (!TABLE_RE.test(table)) return c.json({ message: 'invalid table', code: 'bad_request' }, 400);
  return handleRest(c, c.req.method, table);
});

// ─────────────────────────────────────────────────────────
// /rest/v1/rpc/:fn — Postgres function çağrısı
// ─────────────────────────────────────────────────────────
const RPC_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

app.post('/rest/v1/rpc/:fn', async (c) => {
  const fn = c.req.param('fn');
  if (!RPC_RE.test(fn)) return c.json({ message: 'invalid rpc', code: 'bad_request' }, 400);
  const auth = requireAuth(c);
  let body: Record<string, any> = {};
  try { body = await c.req.json(); } catch {}
  const params = body && typeof body === 'object' ? body : {};
  const argNames = Object.keys(params);
  const argList = argNames.map((n, i) => `"${n}" => $${i + 1}`).join(', ');
  const sqlText = `SELECT public."${fn}"(${argList}) AS result`;
  const ctx = { userId: auth?.userId, role: auth?.role ?? 'anon', email: auth?.email, jwt: auth?.raw };
  try {
    return await withRequestContext(ctx, async (tx) => {
      const rows = await (tx as any).unsafe(sqlText, argNames.map((n) => params[n]));
      const result = rows[0]?.result;
      // PostgREST: skaler ya da array dönebilir
      return c.json(result ?? null);
    });
  } catch (e: any) {
    console.error(`[rpc] ${fn}:`, e.message);
    return c.json({ message: e.message, code: 'rpc_error' }, 400);
  }
});

// ─────────────────────────────────────────────────────────
// /functions/v1/<name> — Edge function: gerçek + stublar
// ─────────────────────────────────────────────────────────
app.get('/functions/v1/', (c) => listFunctions(c));

// Google OAuth — init (frontend GET) + callback (Google redirect GET)
app.get('/functions/v1/google-oauth-callback', (c) => handleGoogleOAuthCallback(c));
app.post('/functions/v1/google-calendar-pull', (c) => handleCalendarPull(c));
app.post('/functions/v1/google-calendar-push', (c) => handleCalendarPush(c));

// Test mail at — auth'la korumalı, sadece super_admin
app.post('/functions/v1/email-test', async (c) => {
  const auth = requireAuth(c);
  if (!auth) return c.json({ message: 'Auth gerek' }, 401);
  if (auth.role !== 'super_admin') return c.json({ message: 'super_admin gerek' }, 403);
  const body = await c.req.json().catch(() => ({}));
  const to = body.to ?? auth.email;
  const result = await sendTestEmail(to);
  return c.json(result, result.status === 'queued' ? 200 : 500);
});

// Storefront public API — catalog/product/availability/booking/voucher/reviews
app.all('/functions/v1/storefront-api', (c) => handleStorefrontApi(c));

// Stripe — checkout session create + webhook (capture → ledger). Key-gated.
app.all('/functions/v1/cc-stripe', (c) => handleCcStripe(c));

// Notifications dispatcher — platform_admin manual trigger / retry ({ ids: [...] })
app.post('/functions/v1/notifications-dispatch', (c) => handleNotificationsDispatch(c));

// Geri kalan edge function'lar henüz stub
app.all('/functions/v1/:fn', (c) => handleFunctionStub(c, c.req.param('fn')));
app.all('/functions/v1/:fn/*', (c) => handleFunctionStub(c, c.req.param('fn')));

// ─────────────────────────────────────────────────────────
// /storage/v1/* — Supabase Storage'a geçici reverse proxy
// (Faz 2: lokal /var/www/storage'a indir + nginx'ten serv)
// ─────────────────────────────────────────────────────────
app.all('/storage/v1/*', (c) => handleStorageProxy(c));

// ─────────────────────────────────────────────────────────
// 404 + error
// ─────────────────────────────────────────────────────────
app.notFound((c) => c.json({ message: 'Bulunamadı', code: 'not_found' }, 404));
app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ message: err.message, code: 'internal_error' }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, ({ port, address }) => {
  console.log(`✓ @api/concierge ${address}:${port}'da dinliyor`);
  console.log(`  Health: http://${address}:${port}/health`);
  console.log(`  REST  : http://${address}:${port}/rest/v1/<table>`);
  console.log(`  Auth  : http://${address}:${port}/auth/v1/token`);
});

// In-process background workers (env-gated)
startNotificationsRunner();

process.on('SIGTERM', async () => {
  console.log('SIGTERM, kapanıyor...');
  await sql.end();
  process.exit(0);
});
