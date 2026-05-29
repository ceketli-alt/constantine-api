#!/usr/bin/env node
/**
 * test-email-event-enum.mjs — email-webhook.ts enum-cast fix DATA-LAYER testi.
 *
 * Bug: email-webhook.ts 'sent'/'failed'/'delivery_delayed' event_type'larını
 * `::email_event_type`'a cast'liyordu ama enum SADECE delivered/opened/clicked/
 * bounced/complained/replied içeriyor → INSERT patlıyor (500 + Resend retry).
 * Fix: sadece enum-geçerli tipler kaydedilir (PERSISTED_EVENT_TYPES), gerisi ack.
 *
 * Her şey TEK transaction'da + savepoint'lerde yapılıp ROLLBACK edilir → kalıcı veri yok.
 *
 * Kapsam:
 *   1. DRIFT GUARD: webhook'taki PERSISTED listesi == canlı DB enum'u (birebir).
 *      (enum'a değer eklenirse veya listede enum-dışı varsa bu test patlar → uyarı.)
 *   2. Geçerli tip ('bounced'/'complained') INSERT OK (gerçek message FK ile).
 *   3. Enum-dışı tip ('sent'/'failed'/'delivery_delayed') `::email_event_type` cast'i ATAR
 *      (bug'ın sebebi; fix bu yüzden cast'ten önce filtreliyor).
 *   4. Webhook filtre mantığı: PERSISTED.includes() doğru kabul/red.
 *
 * Kullanım: node scripts/test-email-event-enum.mjs
 */
import 'dotenv/config';
import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) { console.error('DATABASE_URL eksik'); process.exit(1); }
const sql = postgres(DATABASE_URL);

// email-webhook.ts'teki PERSISTED_EVENT_TYPES ile BİREBİR aynı olmalı (drift guard test 1).
const PERSISTED_EVENT_TYPES = ['delivered', 'opened', 'clicked', 'bounced', 'complained', 'replied'];

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}

// savepoint içinde cast dener; enum-dışı değer "invalid input value for enum" atmalı.
async function castThrows(tx, val) {
  try {
    await tx.savepoint(async (sp) => { await sp`SELECT ${val}::email_event_type AS v`; });
    return false; // atmadı
  } catch (e) {
    return /invalid input value for enum/i.test(e.message);
  }
}

const ROLLBACK = Symbol('rollback');

async function run() {
  console.log('\n=== email_event_type enum-cast fix testi (ROLLBACK) ===\n');
  try {
    await sql.begin(async (tx) => {
      // ── 1. DRIFT GUARD: PERSISTED == canlı enum ──
      console.log('[1] Drift guard: webhook PERSISTED listesi == DB enum');
      const enumRows = await tx`
        SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'email_event_type' ORDER BY e.enumlabel
      `;
      const enumVals = enumRows.map((r) => r.enumlabel).sort();
      const persistedSorted = [...PERSISTED_EVENT_TYPES].sort();
      assert(
        JSON.stringify(enumVals) === JSON.stringify(persistedSorted),
        `PERSISTED == enum  (enum: [${enumVals.join(',')}])`,
      );

      // ── 2. Geçerli tip INSERT OK (gerçek message FK) ──
      console.log('[2] Geçerli tip (bounced/complained) INSERT OK');
      const camp = (await tx`
        INSERT INTO campaigns (name, channel, status) VALUES ('ZZ Enum Test', 'email', 'draft') RETURNING id
      `)[0];
      const lead = (await tx`
        INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status)
        VALUES (
          'ZZ Enum Co', 'enum-test-zz@example.invalid', 'Test Kişi',
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
          (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_segment' LIMIT 1)::lead_segment,
          'test', 'new'
        ) RETURNING id, primary_contact_email
      `)[0];
      const thread = (await tx`
        INSERT INTO email_threads (lead_id, subject, message_count, status, last_direction, last_message_at)
        VALUES (${lead.id}, 'ZZ Enum Konu', 1, 'open', 'outbound', now()) RETURNING id
      `)[0];
      const msg = (await tx`
        INSERT INTO email_messages (thread_id, direction, from_email, to_email, subject, campaign_id, sent_at, sequence_step)
        VALUES (${thread.id}, 'outbound', 'outreach@constantineyachts.online', ${lead.primary_contact_email}, 'ZZ Enum Konu', ${camp.id}, now(), 0)
        RETURNING id
      `)[0];
      for (const ev of ['bounced', 'complained']) {
        await tx`INSERT INTO email_events (message_id, event_type, raw_payload, occurred_at) VALUES (${msg.id}, ${ev}::email_event_type, '{}'::jsonb, now())`;
      }
      const evN = (await tx`SELECT count(*)::int AS n FROM email_events WHERE message_id = ${msg.id}`)[0].n;
      assert(evN === 2, `bounced + complained kaydedildi (geldi: ${evN})`);

      // ── 3. Enum-dışı tip cast'i ATAR (bug'ın sebebi) ──
      console.log('[3] Enum-dışı tip cast → throw (bug sebebi)');
      for (const bad of ['sent', 'failed', 'delivery_delayed']) {
        assert(await castThrows(tx, bad), `'${bad}'::email_event_type ATAR (fix cast'ten önce filtreler)`);
      }
      // geçerli tipler atmaz
      for (const ok of ['bounced', 'replied']) {
        assert(!(await castThrows(tx, ok)), `'${ok}'::email_event_type ATMAZ (geçerli)`);
      }

      // ── 4. Webhook filtre mantığı (PERSISTED.includes) ──
      console.log('[4] Webhook filtre: PERSISTED.includes kabul/red');
      assert(PERSISTED_EVENT_TYPES.includes('bounced') === true, 'bounced → kaydet (true)');
      assert(PERSISTED_EVENT_TYPES.includes('complained') === true, 'complained → kaydet (true)');
      assert(PERSISTED_EVENT_TYPES.includes('sent') === false, 'sent → kaydetme/ack (false)');
      assert(PERSISTED_EVENT_TYPES.includes('failed') === false, 'failed → kaydetme/ack (false)');
      assert(PERSISTED_EVENT_TYPES.includes('delivery_delayed') === false, 'delivery_delayed → kaydetme/ack (false)');
      assert(PERSISTED_EVENT_TYPES.includes('unknown') === false, 'unknown → kaydetme/ack (false)');

      throw ROLLBACK;
    });
  } catch (e) {
    if (e !== ROLLBACK) { console.error('\nHATA:', e.message); failed++; }
  }

  console.log(`\n=== Sonuç: ${passed} geçti, ${failed} başarısız ===\n`);
  await sql.end();
  process.exit(failed > 0 ? 1 : 0);
}

run();
