/**
 * Edge function stub router — Supabase'in /functions/v1/* karşılığı
 * Henüz port edilmemiş fonksiyonlar için kontrollü 503 döner.
 * Her stub'ın amacı yazılı (TODO comment) — sırayla port edilecek.
 */
import type { Context } from 'hono';

interface FnInfo {
  name: string;
  description: string;
  status: 'stub' | 'partial' | 'ready';
}

const FUNCTIONS: Record<string, FnInfo> = {
  // Gmail / OAuth
  'gmail-oauth-callback': { name: 'gmail-oauth-callback', description: 'Google OAuth dönüş URL\'si — kullanıcı hesabını profile\'a bağlar', status: 'stub' },
  'gmail-send':           { name: 'gmail-send',           description: 'Gmail API ile mail gönderir', status: 'stub' },

  // Email (Resend)
  'email-webhook':        { name: 'email-webhook',        description: 'Resend webhook — delivered/opened/clicked/bounced/complained', status: 'stub' },

  // WhatsApp (Meta)
  'wp-send':              { name: 'wp-send',              description: 'Meta WhatsApp Business API ile template mesaj gönder', status: 'stub' },
  'wp-webhook':           { name: 'wp-webhook',           description: 'WhatsApp inbound + button reply webhook', status: 'stub' },

  // IYS (Turkish opt-out registry)
  'iys-check':            { name: 'iys-check',            description: 'IYS opt-out registry kontrolü (stub mode olabilir)', status: 'stub' },

  // Cron jobs (pg_cron'dan değil, biz sistem cron + endpoint olarak yapacağız)
  'cron-daily-digest':    { name: 'cron-daily-digest',    description: 'Her sabah team\'e günlük rapor maili', status: 'stub' },
  'cron-overdue':         { name: 'cron-overdue',         description: 'Geciken bookings/tasks tarama', status: 'stub' },
  'cron-recurring':       { name: 'cron-recurring',       description: 'Aylık expense/task şablonlarını instantiate eder', status: 'stub' },

  // Agency / Public surfaces
  'agency-panel':         { name: 'agency-panel',         description: 'Public agency token bazlı view', status: 'stub' },

  // Misc
  'reply-classify':       { name: 'reply-classify',       description: 'Email reply\'ı OpenAI ile sınıflandır (hot/warm/cold)', status: 'stub' },
  'lead-enrich':          { name: 'lead-enrich',          description: 'TÜRSAB lead\'ini website + email enrichment', status: 'stub' },
};

export function handleFunctionStub(c: Context, fnName: string): Response {
  const info = FUNCTIONS[fnName];
  if (!info) {
    return c.json({
      error: 'function_not_found',
      message: `'${fnName}' Supabase Edge Function lokalde tanımlı değil`,
      hint: 'Bu fonksiyon henüz port edilmedi. Listeyi /functions/v1/ adresinden gör.',
    }, 404);
  }
  return c.json({
    error: 'not_implemented',
    function: fnName,
    description: info.description,
    status: info.status,
    message: 'Bu Edge Function henüz lokal API\'ye port edilmedi. Geçici olarak devre dışı.',
    fallback: 'İlgili UI eylemi bu sebepten çalışmayacak. Aziz/Claude\'a bildir.',
  }, 503);
}

export function listFunctions(c: Context): Response {
  return c.json({
    available: Object.values(FUNCTIONS),
    count: Object.keys(FUNCTIONS).length,
  });
}
