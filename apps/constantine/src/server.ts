/**
 * @api/constantine — Constantine Yachts CRM backend
 * Port: 4001
 * DB: constantine (Postgres 16, localhost)
 *
 * Supabase drop-in replacement:
 *   /rest/v1/:table  → PostgREST uyumlu CRUD
 *   /rpc/:fn         → Supabase RPC karşılığı (DB function çağrısı)
 *   /auth/v1/token   → password login
 *   /storage/v1/...  → (Faz 2: lokal disk + nginx)
 */
import './load-env.js'; // ← MUST BE FIRST: .env'i tüm diğer import'lardan önce yükler (override:true)
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { secureHeaders } from 'hono/secure-headers';
import { sql, withRequestContext } from './db.js';
import { authnMiddleware, requireAuth } from './middleware.js';
import { handleRest } from './rest.js';
// functions-stub.ts kaldırıldı (Faz 4 cleanup, 2026-05-24) — tüm fn'ler artık port edildi
// storage-proxy decommissioned (Faz 4) — nginx artık /storage/v1/* için direkt /var/www/storage'tan serv ediyor
import { handleResendWebhook } from './email-webhook.js';
import { handleResendInbound } from './email-inbound.js';
import { handleEmailSend } from './email-send.js';
import { handleUnsubscribe } from './unsubscribe.js';
import { handleReplyClassify } from './reply-classify.js';
import { handleReplyDraft } from './reply-draft.js';
import { handleGenerateIcebreaker } from './icebreaker.js';
import { handleIysCheck } from './iys-check.js';
import { handleAgencyPanel } from './agency-panel.js';
import { handleBoatOnboarding } from './boat-onboarding.js';
import { handleAgencyForwardNotify } from './agency-forward-notify.js';
import { handleEnrollLeads } from './sales-enrollment.js';
import { startCampaignWorker, stopCampaignWorker } from './campaign-worker.js';
import { startCronScheduler, stopCronScheduler } from './cron-scheduler.js';
import { startMailcowReplyPoller, stopMailcowReplyPoller } from './mailcow-reply-poller.js';
import { handleWarmupTick } from './cron-warmup-tick.js';
import { handleRecomputeScores } from './cron-recompute-scores.js';
import { handleCronDailyDigest } from './cron-daily-digest.js';
import { handleCronWeeklyDigest } from './cron-weekly-digest.js';
import { handleDailyDigest } from './daily-digest.js';
import { handleWpSend } from './wp-send.js';
import { handleWpWebhook } from './wp-webhook.js';
import { handleMailMetrics, handleMailHealth, handleMailEvents } from './mail-metrics.js';
import { handleSettlementSnapshot, handleSettlementTransfer, handleSettlementTransferDelete } from './settlement.js';
import { handleGoogleOAuthCallback } from './google-oauth.js';
import { handleCalendarPull, handleCalendarPush, handleCalendarImport, handleCalendarBackfill } from './google-calendar.js';
import { handlePartnerCalendarSync } from './partner-calendar-sync.js';
import { handleConstantineSyncProvision, handleConstantineSyncRun } from './constantine-sync.js';
import { sendTestEmail, sendEmail } from './resend-send.js';
import {
  verifyAnyJWT,
  verifyRefreshToken,
  lookupUserByEmail,
  verifyPassword,
  issueAccessToken,
  issueRefreshToken,
  hashPassword,
  setUserPassword,
} from './auth.js';

const PORT = Number(process.env.PORT ?? 4001);
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '*').split(',').map((s) => s.trim());

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
      app: 'constantine',
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

    // Lokal Argon2 hash check (legacy Supabase fallback kaldırıldı — Faz 4)
    let ok = false;
    if (user.password_hash && user.password_hash.startsWith('$argon2')) {
      ok = await verifyPassword(String(password), user.password_hash);
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
  // Supabase JS client'ı access_token expiry'sine yaklaşırken otomatik çağırır.
  // Backend bunu desteklemezse her ~1 saatte browser logout olur.
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
    // User'ı tekrar fetch et — rolünü/aktiflik durumunu kontrol için (revoke desteği)
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
    // Rotating refresh — her refresh'te yeni token, eskisi (jwt stateless) doğal expire eder.
    const refresh_token = await issueRefreshToken(session);
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
  // Identifier injection guard — argNames double-quoted SQL identifier'a interpolated edilir.
  for (const n of argNames) {
    if (!RPC_RE.test(n)) {
      return c.json({ message: `invalid rpc arg name: ${n}`, code: 'bad_request' }, 400);
    }
  }
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
app.get('/functions/v1/', (c) => c.json({
  ports: [
    'email-send', 'email-inbound', 'email-webhook', 'reply-classify',
    'iys-check', 'agency-panel', 'enroll-leads',
    'cron-tick-warmup', 'cron-recompute-scores', 'cron-overdue', 'cron-recurring',
    'cron-daily-digest', 'cron-weekly-digest', 'daily-digest',
    'wp-send', 'wp-webhook',
    'gmail-oauth-callback', 'google-oauth-callback',
    'google-calendar-pull', 'google-calendar-push', 'google-calendar-import', 'google-calendar-backfill',
    'partner-calendar-sync', 'constantine-sync-provision', 'constantine-sync-run',
    'mail-metrics', 'mail-health', 'mail-events',
  ],
}));

// Resend webhook — Resend Dashboard'da bu URL'ye event'ler düşer
app.post('/functions/v1/email-webhook', (c) => handleResendWebhook(c));

// Resend send — sales UI'ın ana send akışı (CampaignWizard, LeadEmailCompose, ReplyComposer)
app.post('/functions/v1/email-send', (c) => handleEmailSend(c));

// Admin: kullanıcı şifresini sıfırla (sadece super_admin) — Settings → StaffPanel'den
// çağrılır. Yeni şifre Argon2 hash'lenip auth.users.password_hash'e yazılır.
// Audit: activity_events.event_type = 'admin_password_reset' (category=critical).
app.post('/functions/v1/admin-set-password', async (c) => {
  const auth = requireAuth(c);
  if (!auth?.userId) return c.json({ error: 'unauthorized' }, 401);
  const callerProf = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId} LIMIT 1`;
  if (callerProf[0]?.role !== 'super_admin') {
    return c.json({ error: 'forbidden', detail: 'Sadece super_admin şifre sıfırlayabilir' }, 403);
  }

  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: 'invalid_json' }, 400); }
  const userId: string | undefined = body?.user_id;
  const newPassword: string | undefined = body?.new_password;
  if (!userId || typeof userId !== 'string') {
    return c.json({ error: 'invalid_request', detail: 'user_id gerekli' }, 400);
  }
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 6) {
    return c.json({ error: 'invalid_request', detail: 'new_password en az 6 karakter olmalı' }, 400);
  }

  const target = await sql<Array<{ id: string; email: string }>>`
    SELECT id, email FROM auth.users WHERE id = ${userId} LIMIT 1
  `;
  if (!target[0]) return c.json({ error: 'user_not_found' }, 404);

  try {
    await setUserPassword(userId, newPassword);
    try {
      await sql`
        INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
        VALUES (
          ${auth.userId}::uuid, 'admin_password_reset', 'critical', 0, 'profile', ${userId}::uuid,
          ${sql.json({ target_email: target[0].email, source: 'admin_panel' })}
        )
      `;
    } catch (e: any) {
      console.warn('[admin-set-password] audit insert skipped:', e?.message);
    }
    return c.json({ ok: true, user_id: userId, email: target[0].email });
  } catch (e: any) {
    console.error('[admin-set-password] failed:', e);
    return c.json({ error: 'internal_error', message: e?.message ?? 'unknown' }, 500);
  }
});

// Unsubscribe — RFC 8058 one-click (POST, mail sağlayıcısı) + footer linki (GET, insan). Auth YOK (tokenli).
app.get('/functions/v1/unsubscribe', (c) => handleUnsubscribe(c));
app.post('/functions/v1/unsubscribe', (c) => handleUnsubscribe(c));

// Resend inbound — DNS MX → Resend → POST. Reply'lerin otomatik thread'lenmesi için.
app.post('/functions/v1/email-inbound', (c) => handleResendInbound(c));

// Reply classify — inbound mesajı Claude Haiku 4.5 ile 6 kategoride sınıflandır
app.post('/functions/v1/reply-classify', (c) => handleReplyClassify(c));

// Reply draft — inbound yanıta Claude ile yanıt taslağı üret (human-in-the-loop, GÖNDERMEZ)
app.post('/functions/v1/reply-draft', (c) => handleReplyDraft(c));

// Generate icebreaker — lead başına AI kişiselleştirilmiş açılış cümlesi (custom_fields.ai_icebreaker)
app.post('/functions/v1/generate-icebreaker', (c) => handleGenerateIcebreaker(c));

// İYS check — opt-out registry kontrolü (stub mode + 30-gün cache)
app.post('/functions/v1/iys-check', (c) => handleIysCheck(c));

app.post('/functions/v1/enroll-leads', (c) => handleEnrollLeads(c));

// Agency panel — token-bazlı public view (acente paneli)
app.get('/functions/v1/agency-panel', (c) => handleAgencyPanel(c));
app.post('/functions/v1/agency-panel', (c) => handleAgencyPanel(c));

// Self-service kaptan onboarding (v4) — invite(admin)/validate/submit/upload-photo/publish(admin)/submissions(admin)
app.get('/functions/v1/boat-onboarding', (c) => handleBoatOnboarding(c));
app.post('/functions/v1/boat-onboarding', (c) => handleBoatOnboarding(c));

// Partner talebini tekneciye yönlendirme maili (admin, super_admin/partner)
app.post('/functions/v1/agency-forward-notify', (c) => handleAgencyForwardNotify(c));

// Cron jobs (manuel tetikleme için endpoint, scheduler aynı zamanda otomatik çalıştırır)
app.post('/functions/v1/cron-tick-warmup', (c) => handleWarmupTick(c));
app.post('/functions/v1/cron-recompute-scores', (c) => handleRecomputeScores(c));
app.post('/functions/v1/cron-overdue', async (c) => c.json(await (await import('./cron-scheduler.js')).runOverdueTick()));
app.post('/functions/v1/cron-recurring', async (c) => c.json(await (await import('./cron-scheduler.js')).runRecurringTick()));
app.post('/functions/v1/cron-daily-digest', (c) => handleCronDailyDigest(c));
app.post('/functions/v1/cron-weekly-digest', (c) => handleCronWeeklyDigest(c));

// Operations daily digest (TR 09:00) — Gmail OAuth ile system_email_credentials üzerinden gönderim
app.post('/functions/v1/daily-digest', (c) => handleDailyDigest(c));

// WhatsApp send (Meta Cloud API template) + inbound webhook (verify + quick-reply parser)
app.post('/functions/v1/wp-send', (c) => handleWpSend(c));
app.get('/functions/v1/wp-webhook', (c) => handleWpWebhook(c));
app.post('/functions/v1/wp-webhook', (c) => handleWpWebhook(c));

// Mail provider metrics (Resend / future adapter) — `Reports` sayfası için
app.get('/functions/v1/mail-metrics', (c) => handleMailMetrics(c));
app.post('/functions/v1/mail-metrics', (c) => handleMailMetrics(c));
app.get('/functions/v1/mail-health', (c) => handleMailHealth(c));
app.post('/functions/v1/mail-health', (c) => handleMailHealth(c));
app.get('/functions/v1/mail-events', (c) => handleMailEvents(c));
app.post('/functions/v1/mail-events', (c) => handleMailEvents(c));

// Gmail OAuth callback — Google Calendar OAuth flow ile aynı handler, sadece alias
app.get('/functions/v1/gmail-oauth-callback', (c) => handleGoogleOAuthCallback(c));

// Google OAuth — init (frontend GET) + callback (Google redirect GET)
app.get('/functions/v1/google-oauth-callback', (c) => handleGoogleOAuthCallback(c));
app.post('/functions/v1/google-calendar-pull', (c) => handleCalendarPull(c));
app.post('/functions/v1/google-calendar-push', (c) => handleCalendarPush(c));
app.post('/functions/v1/google-calendar-import', (c) => handleCalendarImport(c));
app.post('/functions/v1/google-calendar-backfill', (c) => handleCalendarBackfill(c));

// Partner tekne takvim senkronu — manuel tetik (cron 10dk'da bir otomatik koşar)
app.post('/functions/v1/partner-calendar-sync', (c) => handlePartnerCalendarSync(c));

// Constantine çift-yön takvim senkronu (Simon) — provision (takvim oluştur+paylaş) + manuel tetik
app.post('/functions/v1/constantine-sync-provision', (c) => handleConstantineSyncProvision(c));
app.post('/functions/v1/constantine-sync-run', (c) => handleConstantineSyncRun(c));

// Settlement (Hesaplaşma) — CONSTANTINE teknesi için ortak hesap kitap
app.post('/functions/v1/settlement-snapshot', (c) => handleSettlementSnapshot(c));
app.post('/functions/v1/settlement-transfer', (c) => handleSettlementTransfer(c));
app.delete('/functions/v1/settlement-transfer/:id', (c) => handleSettlementTransferDelete(c));

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

// Bilinmeyen /functions/v1/<fn> → temiz 404
app.all('/functions/v1/:fn', (c) => c.json({
  error: 'function_not_found',
  message: `'${c.req.param('fn')}' bu backend'de tanımlı değil. /functions/v1/ ile listeyi gör.`,
}, 404));
app.all('/functions/v1/:fn/*', (c) => c.json({
  error: 'function_not_found',
  message: `'${c.req.param('fn')}' bu backend'de tanımlı değil.`,
}, 404));

// /storage/v1/* — Artık nginx tarafından lokal /var/www/storage'tan serv ediliyor.
// Hono'ya ulaşırsa demek ki nginx config bozulmuş, 410 Gone döndür ki sorun farkedilsin.
app.all('/storage/v1/*', (c) => c.json({
  error: 'storage_proxy_decommissioned',
  message: 'nginx config kontrol et — /storage/v1/* lokal disk\'ten serv edilmeli',
}, 410));

// ─────────────────────────────────────────────────────────
// 404 + error
// ─────────────────────────────────────────────────────────
app.notFound((c) => c.json({ message: 'Bulunamadı', code: 'not_found' }, 404));
app.onError((err, c) => {
  console.error('[error]', err);
  return c.json({ message: err.message, code: 'internal_error' }, 500);
});

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, ({ port, address }) => {
  console.log(`✓ @api/constantine ${address}:${port}'da dinliyor`);
  console.log(`  Health: http://${address}:${port}/health`);
  console.log(`  REST  : http://${address}:${port}/rest/v1/<table>`);
  console.log(`  Auth  : http://${address}:${port}/auth/v1/token`);
  // In-process campaign worker (5s delay → ilk tick)
  startCampaignWorker();
  // Cron scheduler (warmup-tick daily + recompute-scores 15dk)
  startCronScheduler();
  // Mailcow IMAP reply köprüsü (gated: MAILCOW_REPLY_POLLER_ENABLED)
  startMailcowReplyPoller();
});

process.on('SIGTERM', async () => {
  console.log('SIGTERM, kapanıyor...');
  stopCronScheduler();
  stopCampaignWorker();
  await sql.end();
  process.exit(0);
});
