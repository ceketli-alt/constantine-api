/**
 * Google OAuth callback handler — /functions/v1/google-oauth-callback
 * MODE 1: ?init=1&boat_id=X → Google auth URL üret
 * MODE 2: ?code=...&state=... → token exchange + DB'ye yaz
 */
import type { Context } from 'hono';
import crypto from 'node:crypto';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';
import {
  GOOGLE_OAUTH_AUTH_URL,
  GOOGLE_SCOPE,
  getEnv,
  exchangeCodeForToken,
  fetchGoogleUserInfo,
} from './google.js';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]!));

function htmlResult(title: string, message: string, ok: boolean): Response {
  const color = ok ? '#0a2540' : '#dc2626';
  const html = `<!DOCTYPE html>
<html lang="tr"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;background:#f8f5f0;color:#0a2540;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#fff;border:1px solid #e0d8ce;border-radius:12px;padding:48px;max-width:480px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
h1{margin:0 0 12px;color:${color};font-size:20px;font-weight:600}
p{margin:0 0 20px;color:#6b6560;line-height:1.5}
button{background:#0a2540;color:#fff;border:0;padding:12px 24px;border-radius:8px;font-size:14px;cursor:pointer}
</style></head><body>
<div class="card">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<button onclick="window.close();window.opener&&window.opener.postMessage({type:'google-oauth-${ok ? 'success' : 'error'}'},'*')">Pencereyi Kapat</button>
</div>
<script>
setTimeout(()=>{
  if (window.opener) window.opener.postMessage({type:'google-oauth-${ok ? 'success' : 'error'}'}, '*');
}, 200);
</script>
</body></html>`;
  return new Response(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

export async function handleGoogleOAuthCallback(c: Context): Promise<Response> {
  const url = new URL(c.req.url);
  const init = url.searchParams.get('init');
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  // Redirect URI = bu endpoint'in kendisi (Google bize geri buraya yönlendirir)
  const REDIRECT_URI = `${getEnv('API_PUBLIC_URL')}/functions/v1/google-oauth-callback`;

  // ---------- MODE 1: INIT ----------
  if (init === '1') {
    const boatId = url.searchParams.get('boat_id');
    const onboardingToken = url.searchParams.get('onboarding_token');

    // İki yetki yolu: (1) admin/partner login, (2) geçerli onboarding davet token'ı (kaptan, login YOK).
    let resolvedBoatId: string;
    let stateUserId: string | null;

    if (onboardingToken) {
      // Public kaptan onboarding — davet token boat'a çözülür (v4).
      const invRows = await sql<Array<{ boat_id: string | null; status: string; expires_at: string; created_by: string | null }>>`
        SELECT boat_id, status, expires_at::text AS expires_at, created_by
        FROM boat_onboarding_invites WHERE token = ${onboardingToken} LIMIT 1
      `;
      const inv = invRows[0];
      if (!inv || !inv.boat_id) return c.json({ error: 'invalid_onboarding_token' }, 401);
      if (inv.status === 'published' || new Date(inv.expires_at).getTime() < Date.now()) {
        return c.json({ error: 'onboarding_token_expired' }, 410);
      }
      resolvedBoatId = inv.boat_id;
      stateUserId = inv.created_by; // davet eden admin (audit: google_connected_by)
    } else {
      if (!boatId) return c.json({ error: 'boat_id required' }, 400);
      const auth = requireAuth(c);
      if (!auth) return c.json({ error: 'unauthorized' }, 401);
      const profileRows = await sql`SELECT role::text AS role FROM profiles WHERE id = ${auth.userId} LIMIT 1`;
      const role = profileRows[0]?.role;
      if (!role || (role !== 'super_admin' && role !== 'partner')) {
        return c.json({ error: 'forbidden' }, 403);
      }
      // super_admin tüm boat'ları, partner sadece atandığı boat'ı yönetebilir
      if (role === 'partner') {
        const assigns = await sql`
          SELECT 1 FROM boat_assignments WHERE user_id = ${auth.userId} AND boat_id = ${boatId} AND role = 'partner' LIMIT 1
        `;
        if (assigns.length === 0) return c.json({ error: 'forbidden', boat_id: boatId }, 403);
      }
      resolvedBoatId = boatId;
      stateUserId = auth.userId;
    }

    // CSRF state üret + kaydet
    // Backend B8 fix: expires_at explicit set — DB default'una bel bağlama, eski state'ler
    // replay edilebilirdi (callback'te `new Date(null) < new Date()` = false, hiç expire olmaz).
    // 48 saat: partner tekne sahibine link WhatsApp'la gönderilip sonra tıklanabilsin.
    // Güvenlik aynı: tek kullanımlık (consumed_at), boat-scoped, init auth'lu.
    const stateToken = crypto.randomUUID() + '-' + crypto.randomUUID();
    await sql`
      INSERT INTO google_oauth_states (state, boat_id, user_id, expires_at)
      VALUES (${stateToken}, ${resolvedBoatId}, ${stateUserId}, now() + interval '48 hours')
    `;

    const authUrl = new URL(GOOGLE_OAUTH_AUTH_URL);
    authUrl.searchParams.set('client_id', getEnv('GOOGLE_CLIENT_ID'));
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope', `${GOOGLE_SCOPE} https://www.googleapis.com/auth/userinfo.email`);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('state', stateToken);

    return c.json({ url: authUrl.toString() });
  }

  // ---------- MODE 2: CALLBACK ----------
  if (errorParam) return htmlResult('Google bağlantısı iptal edildi', `Sebep: ${errorParam}`, false);
  if (!code || !state) return htmlResult('Geçersiz istek', 'code veya state eksik.', false);

  const stateRows = await sql`
    SELECT boat_id, user_id, expires_at, consumed_at
    FROM google_oauth_states
    WHERE state = ${state}
    LIMIT 1
  `;
  const stateRow = stateRows[0];
  if (!stateRow) {
    return htmlResult(
      'Bağlantı linki geçersiz',
      'Bu bağlantı linki tanınmadı. Lütfen Constantine yetkilisinden yeni bir bağlantı linki isteyin.',
      false,
    );
  }
  if (stateRow.consumed_at) {
    return htmlResult(
      'Bu link daha önce kullanılmış',
      'Bağlantı linkleri tek kullanımlıktır ve bu link daha önce kullanılmış. ' +
        'Lütfen Constantine yetkilisinden YENİ bir bağlantı linki isteyip onunla tekrar deneyin.',
      false,
    );
  }
  if (new Date(stateRow.expires_at) < new Date()) {
    return htmlResult(
      'Bağlantı linkinin süresi dolmuş',
      'Bu bağlantı linkinin süresi dolmuş. Lütfen Constantine yetkilisinden yeni bir bağlantı linki isteyin.',
      false,
    );
  }

  try {
    const tokens = await exchangeCodeForToken(code, REDIRECT_URI);
    if (!tokens.refresh_token) {
      return htmlResult('Refresh token alınamadı',
        'Google hesabınızdan bu uygulamanın iznini kaldırıp tekrar deneyin: myaccount.google.com/permissions',
        false);
    }

    // Takvim izni GERÇEKTEN verildi mi? Email-only grant'te freeBusy 403
    // ACCESS_TOKEN_SCOPE_INSUFFICIENT döner; yanlışlıkla "bağlandı ✓" yazmayalım.
    // Tekneci izin ekranında takvim kutucuğunu işaretlemezse buraya düşer.
    if (!tokens.scope || !tokens.scope.includes(GOOGLE_SCOPE)) {
      return htmlResult(
        'Takvim izni eksik',
        'Bağlantı tamamlanamadı çünkü "Google Takvim" erişim izni onaylanmadı. ' +
          'Lütfen linke tekrar tıklayın ve izin ekranında TAKVİM kutucuğunu işaretleyerek devam edin.',
        false,
      );
    }

    const userInfo = await fetchGoogleUserInfo(tokens.access_token);
    const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();

    await sql`
      INSERT INTO boat_google_credentials
        (boat_id, refresh_token, access_token, access_token_expires_at, scope, updated_at)
      VALUES
        (${stateRow.boat_id}, ${tokens.refresh_token}, ${tokens.access_token}, ${expiresAt}, ${tokens.scope}, now())
      ON CONFLICT (boat_id) DO UPDATE SET
        refresh_token = EXCLUDED.refresh_token,
        access_token = EXCLUDED.access_token,
        access_token_expires_at = EXCLUDED.access_token_expires_at,
        scope = EXCLUDED.scope,
        updated_at = now()
    `;

    await sql`
      UPDATE boats SET
        google_calendar_connected = true,
        google_calendar_email = ${userInfo.email},
        google_calendar_id = 'primary',
        google_connected_at = now(),
        google_connected_by = ${stateRow.user_id}
      WHERE id = ${stateRow.boat_id}
    `;

    await sql`UPDATE google_oauth_states SET consumed_at = now() WHERE state = ${state}`;

    return htmlResult('Google Calendar bağlandı ✓', `${userInfo.email} hesabı tekneye bağlandı.`, true);
  } catch (e: any) {
    console.error('[google-oauth-callback] error:', e);
    return htmlResult('Bağlantı hatası', e.message ?? 'Bilinmeyen hata', false);
  }
}
