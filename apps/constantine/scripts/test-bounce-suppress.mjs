#!/usr/bin/env node
/**
 * test-bounce-suppress.mjs — email-webhook bounce/complaint suppression DATA-LAYER testi.
 *
 * email-webhook.ts'in bounce/complaint geldiğinde çalıştırdığı GERÇEK SQL'leri test eder:
 *   1. Lead bounce adresinden case-insensitive bulunur, identifier = lead'in STORED email'i
 *   2. unsubscribes'e eklenir (idempotent — UNIQUE(channel, identifier))
 *   3. lead → status='opted_out' + opted_out_* alanları
 *   4. campaign_targets (queued/sent) → status='opted_out', next_followup_at=NULL (takip durur)
 *   5. email-send'in send-time suppression sorgusu artık bu adresi bloklar (exact match)
 *   6. Idempotency: ON CONFLICT tekrar çalıştırınca patlamaz, mükerrer satır olmaz
 *   7. complaint → reason='spam_complaint'
 *
 * Her şey TEK transaction'da yapılıp ROLLBACK edilir → hiçbir gerçek veri kalıcı olmaz.
 * Kullanım: node scripts/test-bounce-suppress.mjs
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }
const sql = postgres(DATABASE_URL);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ ${msg}`); }
}

const ROLLBACK = Symbol('rollback');

/** email-webhook.ts bounce/complaint bloğunun bire bir SQL'i (tx üzerinde). */
async function runSuppression(tx, recipientEmail, eventType) {
  const reason = eventType === 'complained' ? 'spam_complaint' : 'hard_bounce';
  const leadRows = await tx`
    SELECT id, primary_contact_email FROM leads
    WHERE lower(primary_contact_email) = lower(${recipientEmail}) LIMIT 1
  `;
  const suppressIdentifier = leadRows[0]?.primary_contact_email ?? recipientEmail;
  await tx`
    INSERT INTO unsubscribes (channel, identifier, reason, source)
    VALUES ('email', ${suppressIdentifier}, ${reason}, 'resend_webhook')
    ON CONFLICT (channel, identifier) DO NOTHING
  `;
  if (leadRows[0]?.id) {
    const leadId = leadRows[0].id;
    await tx`
      UPDATE leads SET status='opted_out', opted_out_at=COALESCE(opted_out_at, now()),
        opted_out_channel='email', opted_out_reason=${reason} WHERE id=${leadId}
    `;
    await tx`
      UPDATE campaign_targets SET status='opted_out', next_followup_at=NULL
      WHERE lead_id=${leadId} AND status IN ('queued','sent')
    `;
  }
  return { reason, suppressIdentifier, leadId: leadRows[0]?.id ?? null };
}

async function main() {
  console.log('\n=== Bounce/complaint suppression data-layer testi (ROLLBACK) ===\n');
  try {
    await sql.begin(async (tx) => {
      const tpls = await tx`SELECT id FROM email_templates ORDER BY created_at LIMIT 1`;
      const tA = tpls[0].id;

      // Mixed-case email → case-insensitive lookup + stored-value identifier testi
      const STORED_EMAIL = 'Bounce-Test-ZZ@Example.Invalid';
      const leadRows = await tx`
        INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status)
        VALUES (
          'ZZ Bounce Test Co', ${STORED_EMAIL}, 'Test Kişi',
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_segment' LIMIT 1)::lead_segment,
          'test', 'new'
        ) RETURNING id, primary_contact_email
      `;
      const leadId = leadRows[0].id;

      const campRows = await tx`
        INSERT INTO campaigns (name, channel, template_id, daily_cap, status, follow_up_steps)
        VALUES ('ZZ Bounce Test Campaign', 'email', ${tA}, 16, 'running',
          ${tx.json([{ template_id: tA, delay_days: 3 }])})
        RETURNING id
      `;
      const campId = campRows[0].id;

      // Target 'sent' + takip planlı (trigger next_followup_at set eder)
      const tgtRows = await tx`
        INSERT INTO campaign_targets (campaign_id, lead_id, status)
        VALUES (${campId}, ${leadId}, 'queued') RETURNING id
      `;
      const tgtId = tgtRows[0].id;
      await tx`UPDATE campaign_targets SET status='sent', sent_at=now() WHERE id=${tgtId}`;
      const beforeTgt = (await tx`SELECT status, next_followup_at FROM campaign_targets WHERE id=${tgtId}`)[0];
      assert(beforeTgt.status === 'sent' && beforeTgt.next_followup_at !== null,
        'kurulum: target sent + takip planlı (next_followup_at dolu)');

      // ── HARD BOUNCE simülasyonu — adres farklı case ile gelir (Resend data.to[0]) ──
      console.log('[bounce] hard bounce işle (gelen adres lowercase)');
      const r = await runSuppression(tx, 'bounce-test-zz@example.invalid', 'bounced');
      assert(r.leadId === leadId, 'case-insensitive lookup lead’i buldu');
      assert(r.suppressIdentifier === STORED_EMAIL, 'identifier = lead’in STORED (mixed-case) email’i');

      // 1. unsubscribes
      const unsub = await tx`SELECT channel, identifier, reason, source FROM unsubscribes
        WHERE identifier=${STORED_EMAIL} AND channel='email'`;
      assert(unsub.length === 1, 'unsubscribes satırı eklendi (1 adet)');
      assert(unsub[0].reason === 'hard_bounce', 'reason = hard_bounce');
      assert(unsub[0].source === 'resend_webhook', 'source = resend_webhook');

      // 2. lead opt-out
      const lead = (await tx`SELECT status, opted_out_at, opted_out_channel, opted_out_reason FROM leads WHERE id=${leadId}`)[0];
      assert(lead.status === 'opted_out', 'lead.status = opted_out');
      assert(lead.opted_out_at !== null, 'lead.opted_out_at dolu');
      assert(lead.opted_out_channel === 'email', 'lead.opted_out_channel = email');
      assert(lead.opted_out_reason === 'hard_bounce', 'lead.opted_out_reason = hard_bounce');

      // 3. takip durdu
      const tgt = (await tx`SELECT status, next_followup_at FROM campaign_targets WHERE id=${tgtId}`)[0];
      assert(tgt.status === 'opted_out', 'campaign_target.status = opted_out');
      assert(tgt.next_followup_at === null, 'campaign_target.next_followup_at = NULL (takip durdu)');

      // 4. email-send'in send-time suppression sorgusu artık bloklar (exact match, email-send.ts:299-304)
      const sendCheck = await tx`
        SELECT id FROM unsubscribes WHERE identifier=${STORED_EMAIL} AND channel IN ('email','all') LIMIT 1
      `;
      assert(sendCheck.length === 1, 'email-send suppression sorgusu bu adresi artık bloklar');

      // 5. Idempotency — aynı bounce tekrar gelir (Resend retry)
      console.log('[idempotency] aynı bounce ikinci kez');
      await runSuppression(tx, 'bounce-test-zz@example.invalid', 'bounced');
      const unsubAfter = await tx`SELECT count(*)::int AS n FROM unsubscribes WHERE identifier=${STORED_EMAIL} AND channel='email'`;
      assert(unsubAfter[0].n === 1, 'ON CONFLICT: ikinci bounce mükerrer satır YARATMADI (hâlâ 1)');

      // ── COMPLAINT reason testi (ayrı lead) ──
      console.log('[complaint] spam complaint → reason=spam_complaint');
      const lead2 = (await tx`
        INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status)
        VALUES ('ZZ Complaint Co', 'complaint-zz@example.invalid', 'K2',
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_segment' LIMIT 1)::lead_segment,
          'test', 'new') RETURNING id
      `)[0];
      const rc = await runSuppression(tx, 'complaint-zz@example.invalid', 'complained');
      assert(rc.reason === 'spam_complaint', 'complaint reason = spam_complaint');
      const unsub2 = (await tx`SELECT reason FROM unsubscribes WHERE identifier='complaint-zz@example.invalid' AND channel='email'`)[0];
      assert(unsub2?.reason === 'spam_complaint', 'complaint → unsubscribes.reason = spam_complaint');
      const lead2Row = (await tx`SELECT status FROM leads WHERE id=${lead2.id}`)[0];
      assert(lead2Row.status === 'opted_out', 'complaint lead → opted_out');

      // ── Lead'siz adres (warmup/seed/bilinmeyen) → sadece suppress, hata vermez ──
      console.log('[no-lead] lead eşleşmeyen bounce → graceful');
      const rn = await runSuppression(tx, 'unknown-zz@example.invalid', 'bounced');
      assert(rn.leadId === null, 'lead bulunamadı (null)');
      const unsub3 = await tx`SELECT count(*)::int AS n FROM unsubscribes WHERE identifier='unknown-zz@example.invalid'`;
      assert(unsub3[0].n === 1, 'lead’siz adres yine de suppress edildi');

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  console.log(`\n=== ${passed} geçti, ${failed} kaldı (ROLLBACK — kalıcı veri yok) ===\n`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
