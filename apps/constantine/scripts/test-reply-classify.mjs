#!/usr/bin/env node
/**
 * E2E test: reply-classify (Claude Haiku 4.5)
 * Geçici test lead + thread + inbound message yarat, classify çağır, sonra cleanup.
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 2 });
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001';

const TEST_CASES = [
  { body: 'Merhaba, fiyat listenizi gönderebilir misiniz? Yarın görüşmek isteriz.', expect: 'hot' },
  { body: 'Hangi tekneleriniz var? Kapasite nedir?', expect: 'warm' },
  { body: 'Teşekkürler, şimdilik ilgilenmiyoruz. İleride değerlendiririz.', expect: 'cold' },
  { body: 'Pahalı, rakipte daha uygun teklif var.', expect: 'objection' },
  { body: 'Lütfen beni bu maillerden çıkarın. Abonelik iptali istiyorum.', expect: 'opt_out' },
  { body: 'Out of office: I will return on Monday.', expect: 'irrelevant' },
];

// 1. Test lead + thread + messages oluştur
const leadRows = await sql`
  INSERT INTO leads (type, segment, company_name, primary_contact_email, source, status)
  VALUES ('other', 'other', 'TEST Reply Classify', 'classify-test@example.com', 'reply-classify-test', 'contacted')
  RETURNING id
`;
const leadId = leadRows[0].id;
console.log(`[setup] lead: ${leadId}`);

const threadRows = await sql`
  INSERT INTO email_threads (lead_id, subject, message_count, status)
  VALUES (${leadId}, 'Test Classify Thread', 0, 'open')
  RETURNING id
`;
const threadId = threadRows[0].id;
console.log(`[setup] thread: ${threadId}`);

try {
  console.log('\nClaude Haiku 4.5 ile 6 kategori test:\n');
  for (const tc of TEST_CASES) {
    const msgRows = await sql`
      INSERT INTO email_messages (
        thread_id, direction, from_email, to_email, subject, body_text, received_at
      ) VALUES (
        ${threadId}, 'inbound', 'classify-test@example.com', 'noreply@send.constantineyachts.com',
        'Test reply', ${tc.body}, now()
      )
      RETURNING id
    `;
    const msgId = msgRows[0].id;

    const res = await fetch(`${API_URL}/functions/v1/reply-classify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: msgId, thread_id: threadId, lead_id: leadId }),
    });
    const data = await res.json();
    const got = data.classification ?? 'ERROR';
    const status = got === tc.expect ? '✓' : (data.error ? '✗' : '~');
    const conf = data.confidence ? `(${Math.round(data.confidence * 100)}%)` : '';
    console.log(`  ${status} expect=${tc.expect.padEnd(11)} got=${got.padEnd(11)} ${conf}  "${tc.body.slice(0, 50)}${tc.body.length > 50 ? '...' : ''}"`);
    if (data.reasoning) console.log(`     reasoning: ${data.reasoning}`);
    if (data.error) console.log(`     ERROR: ${data.error}`);
  }
} finally {
  // Cleanup
  await sql`DELETE FROM leads WHERE id = ${leadId}`;
  console.log('\n[cleanup] test data silindi');
  await sql.end();
}
