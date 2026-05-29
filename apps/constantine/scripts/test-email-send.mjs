#!/usr/bin/env node
/**
 * E2E test: /functions/v1/email-send endpoint
 *
 * Akış:
 *  1. .env'den JWT_SECRET, super_admin user lookup için DATABASE_URL al
 *  2. Mert'in super_admin user'ı için access token issue et
 *  3. (a) Hatalı lead_id ile dene → 404 Lead bulunamadı
 *  4. (b) Geçici test lead oluştur (email-settings-test source)
 *  5. (c) email-send'e POST at — gerçek mail Resend'e gidecek
 *  6. (d) DB'de email_messages + email_threads + activity_events kayıtlarını oku
 *  7. (e) Test lead'i sil (cleanup)
 *
 * Çalıştır:
 *   cd /var/www/api/apps/constantine
 *   node --env-file=.env scripts/test-email-send.mjs <recipient_email>
 */

import postgres from 'postgres';
import { SignJWT } from 'jose';

const RECIPIENT = process.argv[2];
if (!RECIPIENT || !RECIPIENT.includes('@')) {
  console.error('Usage: node test-email-send.mjs <recipient_email>');
  process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001';

if (!JWT_SECRET) {
  console.error('JWT_SECRET env eksik');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 2 });

// 1. super_admin lookup
const adminRows = await sql`
  SELECT u.id, u.email, p.role::text AS role
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.id = u.id
  WHERE p.role = 'super_admin' AND p.active = true
  ORDER BY u.created_at
  LIMIT 1
`;
const admin = adminRows[0];
if (!admin) {
  console.error('super_admin user bulunamadı');
  process.exit(1);
}
console.log(`[setup] super_admin: ${admin.email} (${admin.id})`);

// 2. JWT issue (Hono backend'in `issueAccessToken` ile aynı format)
const secret = new TextEncoder().encode(JWT_SECRET);
const token = await new SignJWT({
  sub: admin.id,
  email: admin.email,
  role: admin.role,
  iss: 'constantine-api',
})
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secret);
console.log(`[setup] JWT issued (1h expiry)`);

const baseHeaders = {
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
};

// 3a. Hatalı lead_id → 404
const r1 = await fetch(`${API_URL}/functions/v1/email-send`, {
  method: 'POST',
  headers: baseHeaders,
  body: JSON.stringify({ lead_id: '00000000-0000-0000-0000-000000000000' }),
});
const r1json = await r1.json();
console.log(`[test 1] Hatalı lead_id → ${r1.status} ${JSON.stringify(r1json)}`);
if (r1.status !== 404) console.warn('  ⚠ Expected 404');

// 4. Test lead oluştur
const leadRows = await sql`
  INSERT INTO leads (
    type, segment, company_name, primary_contact_email,
    primary_contact_name, source, status
  ) VALUES (
    'other', 'other', 'TEST Constantine Email Send',
    ${RECIPIENT}, 'Test User', 'email-send-script', 'new'
  )
  RETURNING id
`;
const leadId = leadRows[0].id;
console.log(`[setup] test lead: ${leadId} → ${RECIPIENT}`);

let messageId = null;
let threadId = null;

try {
  // 5. POST email-send (no template, custom subject + body)
  const r2 = await fetch(`${API_URL}/functions/v1/email-send`, {
    method: 'POST',
    headers: baseHeaders,
    body: JSON.stringify({
      lead_id: leadId,
      subject: `[E2E] email-send port testi · ${new Date().toLocaleString('tr-TR')}`,
      body_html: `
        <h2>email-send portu çalışıyor ✅</h2>
        <p>Bu mail <strong>api.constantineyachts.com/functions/v1/email-send</strong> üzerinden gönderildi.</p>
        <ul>
          <li>Backend: Hono + Node 20 (api-constantine)</li>
          <li>DB: lokal PostgreSQL 16, email_messages + email_threads insert edilmeli</li>
          <li>Resend: tag={lead_id,template} ile gönderildi</li>
        </ul>
        <p>— Aziz Claude</p>
      `,
      body_text: 'email-send portu çalışıyor. api.constantineyachts.com üzerinden gönderildi.',
    }),
  });
  const r2json = await r2.json();
  console.log(`[test 2] email-send → ${r2.status} ${JSON.stringify(r2json)}`);

  if (r2.status === 200 && r2json.success) {
    messageId = r2json.message_id;
    threadId = r2json.thread_id;
    console.log(`  ✓ message_id=${messageId}`);
    console.log(`  ✓ thread_id=${threadId}`);
    console.log(`  ✓ resend_message_id=${r2json.resend_message_id}`);
  } else {
    console.error('  ✗ Gönderim başarısız');
  }

  // 6. DB doğrulama
  console.log('[verify] DB state:');
  const msgRow = await sql`
    SELECT id, thread_id, direction, from_email, to_email, subject,
           resend_message_id, sent_at, template_id, campaign_id
    FROM email_messages
    WHERE id = ${messageId}
  `;
  console.log('  email_messages:', msgRow[0] ?? '(yok)');

  const thrRow = await sql`
    SELECT id, lead_id, subject, message_count, last_message_at, last_direction, status
    FROM email_threads
    WHERE id = ${threadId}
  `;
  console.log('  email_threads:', thrRow[0] ?? '(yok)');

  const actRows = await sql`
    SELECT id, user_id, event_type, metadata, created_at
    FROM activity_events
    WHERE metadata->>'lead_id' = ${leadId}
       OR (metadata->>'thread_id' = ${threadId} AND event_type LIKE 'email%')
    ORDER BY created_at DESC
    LIMIT 5
  `;
  console.log('  activity_events:', actRows);

  const actRecentRows = await sql`
    SELECT id, event_type, metadata, created_at
    FROM activity_events
    WHERE event_type LIKE 'email%'
    ORDER BY created_at DESC
    LIMIT 3
  `;
  console.log('  activity_events (raw metadata):', JSON.stringify(actRecentRows, null, 2));

  const leadRow = await sql`
    SELECT id, status, last_contacted_at, email_thread_id
    FROM leads
    WHERE id = ${leadId}
  `;
  console.log('  leads:', leadRow[0]);

} finally {
  // 7. Cleanup — sadece messages/threads/events boş kalır (cascade on lead delete)
  await sql`DELETE FROM leads WHERE id = ${leadId}`;
  console.log(`[cleanup] test lead silindi`);
  await sql.end();
}
