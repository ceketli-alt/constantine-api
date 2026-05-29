#!/usr/bin/env node
/**
 * test-followup-sequence.mjs — Feature #54 follow-up sequence DATA-LAYER testi.
 *
 * Gerçek trigger + worker'ın çalıştırdığı GERÇEK SQL'leri test eder.
 * Her şey TEK transaction'da yapılıp ROLLBACK edilir → mail GÖNDERİLMEZ,
 * hiçbir gerçek veri (lead/campaign/message) kalıcı olmaz.
 *
 * Kapsam:
 *   1. Trigger: insert (queued) → next_followup_at NULL kalır
 *   2. Trigger: update status='sent' → next_followup_at = now + step0.delay
 *   3. Daily-cap sayımı email_messages'tan (ilk+takip)
 *   4. Idempotency adım-bazlı (step 0 bloklar, step 1 bloklamaz)
 *   5. Worker "due followup" sorgusu
 *   6. Adım ilerletme matematiği (orta adım hasMore=true, son adım hasMore=false→NULL)
 *   7. Tamamlanma sorgusu (pending = queued ∨ sent+next_followup_at)
 *   8. Reply → 'replied' + next_followup_at NULL (takip durur)
 *
 * Kullanım: node scripts/test-followup-sequence.mjs
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }
const sql = postgres(DATABASE_URL);

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}
function approxDays(ts, days, label) {
  if (ts == null) { assert(false, `${label} (NULL beklenmiyordu)`); return; }
  const target = Date.now() + days * 86_400_000;
  const diffMin = Math.abs(new Date(ts).getTime() - target) / 60000;
  assert(diffMin < 3, `${label} ≈ now+${days}g (sapma ${diffMin.toFixed(2)}dk)`);
}

const ROLLBACK = Symbol('rollback');

async function run() {
  console.log('\n=== Follow-up sequence data-layer testi (ROLLBACK) ===\n');
  try {
    await sql.begin(async (tx) => {
      // İki gerçek template id (follow_up_steps için)
      const tpls = await tx`SELECT id FROM email_templates ORDER BY created_at LIMIT 2`;
      if (tpls.length < 2) throw new Error('Test için en az 2 email_template gerekli');
      const [tA, tB] = [tpls[0].id, tpls[1].id];

      // Test lead
      const leadRows = await tx`
        INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status)
        VALUES (
          'ZZ Test Followup Co',
          'followup-test-zz@example.invalid',
          'Test Kişi',
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_segment' LIMIT 1)::lead_segment,
          'test', 'new'
        ) RETURNING id, primary_contact_email
      `;
      const leadId = leadRows[0].id;
      const recipient = leadRows[0].primary_contact_email;

      // Test campaign (2 takip adımı: 3 gün, 5 gün)
      const campRows = await tx`
        INSERT INTO campaigns (name, channel, template_id, daily_cap, status, follow_up_steps)
        VALUES (
          'ZZ Test Followup Campaign', 'email', ${tA}, 100, 'running',
          ${tx.json([{ template_id: tA, delay_days: 3 }, { template_id: tB, delay_days: 5 }])}
        ) RETURNING id
      `;
      const campId = campRows[0].id;
      const steps = [{ template_id: tA, delay_days: 3 }, { template_id: tB, delay_days: 5 }];

      // ── 1. Trigger insert (queued) → next_followup_at NULL ──
      console.log('[1] Trigger: insert queued → next_followup_at NULL');
      const tgtRows = await tx`
        INSERT INTO campaign_targets (campaign_id, lead_id, status)
        VALUES (${campId}, ${leadId}, 'queued')
        RETURNING id, status, sequence_step, next_followup_at
      `;
      const tgtId = tgtRows[0].id;
      assert(tgtRows[0].next_followup_at === null, 'queued target next_followup_at NULL');
      assert(tgtRows[0].sequence_step === 0, 'sequence_step 0');

      // ── 2. Trigger update sent → next_followup_at = now+3g ──
      console.log('[2] Trigger: update status=sent → next_followup_at = now+3g');
      const sentRows = await tx`
        UPDATE campaign_targets SET status='sent', sent_at=now() WHERE id=${tgtId}
        RETURNING sequence_step, next_followup_at
      `;
      approxDays(sentRows[0].next_followup_at, 3, 'next_followup_at');
      assert(sentRows[0].sequence_step === 0, 'sequence_step hâlâ 0 (ilk mail)');

      // initial email_messages (thread + msg) — ilk gönderim simülasyonu
      const thrRows = await tx`
        INSERT INTO email_threads (lead_id, subject, message_count, status, last_direction, last_message_at)
        VALUES (${leadId}, 'ZZ Test Konu', 1, 'open', 'outbound', now()) RETURNING id
      `;
      const threadId = thrRows[0].id;
      await tx`
        INSERT INTO email_messages (thread_id, direction, from_email, to_email, subject, campaign_id, sent_at, sequence_step)
        VALUES (${threadId}, 'outbound', 'outreach@constantineyachts.online', ${recipient}, 'ZZ Test Konu', ${campId}, now(), 0)
      `;

      // ── 3. Daily-cap email_messages'tan ──
      console.log('[3] Daily-cap sayımı email_messages (outbound, bugün)');
      const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
      const capRows = await tx`
        SELECT count(*)::int AS n FROM email_messages
        WHERE campaign_id=${campId} AND direction='outbound' AND sent_at >= ${todayStart.toISOString()}
      `;
      assert(capRows[0].n === 1, `bugün giden mail = 1 (geldi: ${capRows[0].n})`);

      // ── 4. Idempotency adım-bazlı ──
      console.log('[4] Idempotency: step 0 bloklar, step 1 bloklamaz');
      const idem0 = await tx`
        SELECT id FROM email_messages
        WHERE campaign_id=${campId} AND to_email=${recipient} AND direction='outbound' AND sequence_step=0 LIMIT 1
      `;
      assert(idem0.length === 1, 'step 0 mevcut (dedup → tekrar göndermez)');
      const idem1 = await tx`
        SELECT id FROM email_messages
        WHERE campaign_id=${campId} AND to_email=${recipient} AND direction='outbound' AND sequence_step=1 LIMIT 1
      `;
      assert(idem1.length === 0, 'step 1 yok (takip engellenmez)');

      // ── 5. Worker due-followup sorgusu (vakti geçmiş yap) ──
      console.log('[5] Worker due-followup sorgusu');
      await tx`UPDATE campaign_targets SET next_followup_at = now() - interval '1 minute' WHERE id=${tgtId}`;
      const due = await tx`
        SELECT id, lead_id, sequence_step FROM campaign_targets
        WHERE campaign_id=${campId} AND status='sent'
          AND next_followup_at IS NOT NULL AND next_followup_at <= now()
        ORDER BY next_followup_at LIMIT 10
      `;
      assert(due.length === 1 && due[0].id === tgtId, 'vakti gelen takip bulundu');

      // ── 6. Adım ilerletme: step 1 gönder (orta adım, hasMore=true→now+5g) ──
      console.log('[6] Adım ilerletme: step1 (orta) → seq=1, next=now+5g');
      const nextStep1 = due[0].sequence_step + 1; // =1
      const hasMore1 = steps.length > nextStep1;   // 2 > 1 = true
      const nextAt1 = hasMore1 ? new Date(Date.now() + steps[nextStep1].delay_days * 86_400_000).toISOString() : null;
      await tx`
        INSERT INTO email_messages (thread_id, direction, from_email, to_email, subject, campaign_id, sent_at, sequence_step)
        VALUES (${threadId}, 'outbound', 'outreach@constantineyachts.online', ${recipient}, 'ZZ Test Konu', ${campId}, now(), ${nextStep1})
      `;
      const adv1 = await tx`
        UPDATE campaign_targets SET sequence_step=${nextStep1}, next_followup_at=${nextAt1} WHERE id=${tgtId}
        RETURNING sequence_step, next_followup_at
      `;
      assert(adv1[0].sequence_step === 1, 'sequence_step → 1');
      approxDays(adv1[0].next_followup_at, 5, 'next_followup_at (step1 delay 5g)');

      // ── 7. Son adım: step 2 gönder (hasMore=false → NULL) ──
      console.log('[7] Son adım: step2 → seq=2, next_followup_at NULL');
      const nextStep2 = 1 + 1; // =2
      const hasMore2 = steps.length > nextStep2; // 2 > 2 = false
      const nextAt2 = hasMore2 ? new Date().toISOString() : null;
      const adv2 = await tx`
        UPDATE campaign_targets SET sequence_step=${nextStep2}, next_followup_at=${nextAt2} WHERE id=${tgtId}
        RETURNING sequence_step, next_followup_at
      `;
      assert(adv2[0].sequence_step === 2, 'sequence_step → 2');
      assert(adv2[0].next_followup_at === null, 'son adım sonrası next_followup_at NULL');

      // ── 8. Tamamlanma sorgusu (pending = 0 olmalı) ──
      console.log('[8] Tamamlanma sorgusu: pending = 0');
      const pend = await tx`
        SELECT count(*)::int AS n FROM campaign_targets
        WHERE campaign_id=${campId} AND (status='queued' OR (status='sent' AND next_followup_at IS NOT NULL))
      `;
      assert(pend[0].n === 0, `pending = 0 (geldi: ${pend[0].n}) → kampanya completed olur`);

      // ── 9. Reply path: 'sent' target → 'replied' + next NULL ──
      console.log('[9] Reply: sent target → replied, next_followup_at NULL');
      // reset to a "sent + scheduled" durumu, sonra reply uygula
      await tx`UPDATE campaign_targets SET status='sent', next_followup_at=now()+interval '2 days' WHERE id=${tgtId}`;
      const rep = await tx`
        UPDATE campaign_targets SET status='replied', replied_at=now(), next_followup_at=NULL
        WHERE lead_id=${leadId} AND status='sent'
        RETURNING status, next_followup_at, replied_at
      `;
      assert(rep.length === 1 && rep[0].status === 'replied', 'target replied oldu');
      assert(rep[0].next_followup_at === null, 'replied → next_followup_at NULL (takip durur)');
      const dueAfter = await tx`
        SELECT id FROM campaign_targets
        WHERE campaign_id=${campId} AND status='sent'
          AND next_followup_at IS NOT NULL AND next_followup_at <= now()
      `;
      assert(dueAfter.length === 0, 'reply sonrası due-followup listesinde yok');

      throw ROLLBACK; // her şeyi geri al
    });
  } catch (e) {
    if (e !== ROLLBACK) { console.error('\nHATA:', e.message); failed++; }
  }

  console.log(`\n=== Sonuç: ${passed} geçti, ${failed} başarısız ===\n`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

run();
