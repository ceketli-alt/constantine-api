/**
 * Password recovery (şifre sıfırlama) — token yönetimi + mail template
 *
 * Akış:
 *   1. POST /auth/v1/recover { email }
 *        → generateRecoveryToken(userId) → auth.users.recovery_token + recovery_sent_at güncelle
 *        → sendRecoveryEmail(email, link) → Resend
 *   2. Kullanıcı maildeki linke tıklar → GET /auth/v1/verify?token=...&type=recovery&redirect_to=...
 *        → consumeRecoveryToken(token) → token NULL'a çekilir, userId döner
 *        → access_token + refresh_token mint, 302 redirect to ${redirect_to}#access_token=...
 *   3. Frontend reset-password sayfası Supabase JS'in onAuthStateChange'i sayesinde
 *      session restore eder, kullanıcı yeni şifresini girer → PUT /auth/v1/user.
 */
import { randomBytes } from 'node:crypto';
import { sql } from './db.js';
import { sendEmail } from './resend-send.js';

const RECOVERY_TTL_SECONDS = Number(process.env.RECOVERY_TOKEN_TTL_SECONDS ?? 3600);

export interface ConsumedRecovery {
  userId: string;
  email: string;
}

/** 32 byte random hex token üret ve auth.users'a yaz. */
export async function generateRecoveryToken(userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await sql`
    UPDATE auth.users
    SET recovery_token   = ${token},
        recovery_sent_at = now(),
        updated_at       = now()
    WHERE id = ${userId}
  `;
  return token;
}

/**
 * Token'ı doğrula + tek seferlik tüket.
 * Süresi geçmişse veya bulunamazsa null döner. Bulundu ise NULL'a çekilir.
 */
export async function consumeRecoveryToken(token: string): Promise<ConsumedRecovery | null> {
  if (!token || typeof token !== 'string') return null;
  const rows = await sql<{ id: string; email: string }[]>`
    UPDATE auth.users
    SET recovery_token   = NULL,
        recovery_sent_at = NULL,
        updated_at       = now()
    WHERE recovery_token = ${token}
      AND recovery_sent_at IS NOT NULL
      AND recovery_sent_at > (now() - (${RECOVERY_TTL_SECONDS}::int * interval '1 second'))
    RETURNING id, email
  `;
  if (!rows[0]) return null;
  return { userId: rows[0].id, email: rows[0].email };
}

/** Şifre sıfırlama mailini Resend ile gönderir. */
export async function sendRecoveryEmail(
  toEmail: string,
  recoveryLink: string,
): Promise<{ ok: boolean; error?: string }> {
  const subject = 'Concierge Connect — Şifre sıfırlama isteği';
  const html = buildRecoveryEmailHtml(recoveryLink);
  const text = buildRecoveryEmailText(recoveryLink);
  const result = await sendEmail({
    to: toEmail,
    subject,
    html,
    text,
    tags: [{ name: 'kind', value: 'password_recovery' }],
  });
  if (result.status !== 'queued') {
    return { ok: false, error: result.error ?? 'mail gönderilemedi' };
  }
  return { ok: true };
}

function buildRecoveryEmailHtml(link: string): string {
  const ttlMin = Math.round(RECOVERY_TTL_SECONDS / 60);
  return `<!doctype html>
<html lang="tr">
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color:#1f2937; background:#f9fafb; margin:0; padding:24px;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px; margin:0 auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:8px;">
      <tr><td style="padding:32px 32px 16px 32px;">
        <h1 style="margin:0 0 12px 0; font-size:20px; color:#0f172a;">Şifre sıfırlama</h1>
        <p style="margin:0 0 16px 0; line-height:1.55;">
          Concierge Connect hesabınız için şifre sıfırlama isteği aldık. Yeni şifrenizi belirlemek için aşağıdaki butona tıklayın:
        </p>
        <p style="text-align:center; margin:24px 0;">
          <a href="${link}" style="display:inline-block; padding:12px 24px; background:#0f172a; color:#ffffff; text-decoration:none; border-radius:6px; font-weight:600;">
            Şifreyi sıfırla
          </a>
        </p>
        <p style="margin:0 0 8px 0; color:#475569; font-size:13px;">Bu bağlantı ${ttlMin} dakika geçerlidir ve sadece bir kez kullanılabilir.</p>
        <p style="margin:0 0 8px 0; color:#475569; font-size:13px;">Buton çalışmazsa şu adresi tarayıcınıza yapıştırın:</p>
        <p style="margin:0 0 16px 0; color:#475569; font-size:12px; word-break:break-all;">${link}</p>
        <hr style="border:none; border-top:1px solid #e5e7eb; margin:24px 0;"/>
        <p style="margin:0; color:#94a3b8; font-size:12px; line-height:1.5;">
          Bu maili siz talep etmediyseniz görmezden gelebilirsiniz. Şifreniz değişmeden kalır.
        </p>
      </td></tr>
    </table>
  </body>
</html>`;
}

function buildRecoveryEmailText(link: string): string {
  const ttlMin = Math.round(RECOVERY_TTL_SECONDS / 60);
  return [
    'Concierge Connect — Şifre sıfırlama',
    '',
    'Hesabınız için şifre sıfırlama isteği aldık.',
    'Yeni şifrenizi belirlemek için aşağıdaki bağlantıyı kullanın:',
    '',
    link,
    '',
    `Bağlantı ${ttlMin} dakika geçerlidir ve sadece bir kez kullanılabilir.`,
    'Bu maili siz talep etmediyseniz görmezden gelebilirsiniz.',
  ].join('\n');
}
