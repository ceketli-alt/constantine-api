/**
 * seed-inbox-test.mts — Cold outreach SEED / inbox-placement testi.
 *
 * Amaç: GERÇEK gönderim yolunu test et — DMC ilk-mailini outreach provider'ından
 * (RESEND_API_KEY_OUTREACH → constantineyachts.online DKIM) Mert'in kişisel kutularına
 * gönder, INBOX mı SPAM mı + render (imza/link/telefon) gözle kontrol edilsin.
 *
 * Neden campaign_id ile? email-send.ts:495 → campaign_id varsa provider='outreach'
 * (cy.online), yoksa transactional (send.cy.com). Placement testi için cy.online ŞART.
 * O yüzden 'ZZ SEED TEST' adında bir DRAFT campaign (worker'ın dokunmadığı) açıp
 * onun id'sini campaign_id olarak veriyoruz. sendEmailCore'u DOĞRUDAN çağırıyoruz
 * (worker'ı beklemeden), seed lead'lerin primary_contact_email'i = kişisel adresler.
 *
 * Modlar:
 *   (arg yok)            → DRY: ne yapacağını yazar, GÖNDERMEZ (güvenli default)
 *   npx tsx scripts/seed-inbox-test.mts send     → gerçekten gönderir
 *   npx tsx scripts/seed-inbox-test.mts cleanup   → seed lead/campaign/mesajları siler
 *
 * Çalıştırma: cd /var/www/api/apps/constantine && npx tsx scripts/seed-inbox-test.mts send
 */
import 'dotenv/config';
import { sql } from '../src/db.js';
import { sendEmailCore } from '../src/email-send.js';

const SEED_EMAILS_ALL = [
  'ceketli@gmail.com',
  'mertodemis1986@gmail.com',
  'derincea@gmail.com',
  'mert@asttourism.com',
  'mert@bosphorussunset.com',
  'istanbul@bosphorussunset.com',
  'timur@asttourism.com',
];
// Opsiyonel: tek adrese gönder → `... send ceketli@gmail.com`. Güvenlik: adres listede OLMALI.
const ONLY_EMAIL = (process.argv[3] ?? '').toLowerCase().trim();
const SEED_EMAILS = ONLY_EMAIL
  ? SEED_EMAILS_ALL.filter((e) => e.toLowerCase() === ONLY_EMAIL)
  : SEED_EMAILS_ALL;
const DMC_TEMPLATE_ID = '3a32c3a6-01c6-4d3c-a89d-2226e0df242b'; // outreach_initial_agency_dmc_tr
// SEND_AS env ile sender override edilebilir (mert@ vs outreach@ karşılaştırması)
const OUTREACH_SENDER = (process.env.SEND_AS ?? 'outreach@constantineyachts.online').trim();
const SENDER_TAG = OUTREACH_SENDER.split('@')[0];
const SEED_CAMPAIGN_NAME = `ZZ SEED TEST [${SENDER_TAG}] (silinebilir)`;
const SEED_TAG = 'zz-seed-test';

const MODE = (process.argv[2] ?? 'dry').toLowerCase();

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function superAdminId(): Promise<string> {
  const rows = await sql`SELECT id FROM profiles WHERE role='super_admin' AND active=true ORDER BY created_at LIMIT 1`;
  if (!rows[0]?.id) throw new Error('super_admin profil yok');
  return rows[0].id;
}

/** Seed campaign'i bul ya da oluştur (status='draft' → worker dokunmaz). */
async function ensureSeedCampaign(adminId: string): Promise<string> {
  const found = await sql`SELECT id FROM campaigns WHERE name=${SEED_CAMPAIGN_NAME} LIMIT 1`;
  if (found[0]?.id) return found[0].id;
  const ins = await sql`
    INSERT INTO campaigns (name, description, channel, template_id, sender_email, status, daily_cap, created_by)
    VALUES (${SEED_CAMPAIGN_NAME}, 'Seed/placement testi — gerçek gönderim yok, sadece kişisel kutulara test. Silinebilir.',
            'email', ${DMC_TEMPLATE_ID}, ${OUTREACH_SENDER}, 'draft', 0, ${adminId})
    RETURNING id`;
  return ins[0].id;
}

/** 6 seed lead'i upsert et (email = kişisel adres). seg-dmc/trust-high/email-valid tag'i YOK → 162 pool'a karışmaz. */
async function ensureSeedLeads(): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = [];
  for (const email of SEED_EMAILS) {
    const existing = await sql`SELECT id FROM leads WHERE lower(primary_contact_email)=lower(${email}) AND ${SEED_TAG} = ANY(tags) LIMIT 1`;
    if (existing[0]?.id) { out.push({ id: existing[0].id, email }); continue; }
    const ins = await sql`
      INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status, tags)
      VALUES (
        'Örnek DMC Acente', ${email}, 'Yetkili',
        (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
        'dmc'::lead_segment, 'seed-test', 'new', ARRAY[${SEED_TAG}]::text[]
      ) RETURNING id`;
    out.push({ id: ins[0].id, email });
  }
  return out;
}

async function cleanup(): Promise<void> {
  const camp = await sql`SELECT id FROM campaigns WHERE name=${SEED_CAMPAIGN_NAME} LIMIT 1`;
  const campId = camp[0]?.id ?? null;
  const leads = await sql`SELECT id FROM leads WHERE ${SEED_TAG} = ANY(tags)`;
  const leadIds = leads.map((r: any) => r.id);
  if (campId) await sql`DELETE FROM email_events WHERE message_id IN (SELECT id FROM email_messages WHERE campaign_id=${campId})`;
  if (campId) await sql`DELETE FROM email_messages WHERE campaign_id=${campId}`;
  if (leadIds.length) {
    await sql`DELETE FROM email_messages WHERE thread_id IN (SELECT id FROM email_threads WHERE lead_id = ANY(${leadIds}))`;
    await sql`DELETE FROM email_threads WHERE lead_id = ANY(${leadIds})`;
    await sql`DELETE FROM campaign_targets WHERE lead_id = ANY(${leadIds})`;
    await sql`DELETE FROM leads WHERE id = ANY(${leadIds})`;
  }
  if (campId) await sql`DELETE FROM campaign_warmup_state WHERE campaign_id=${campId}`;
  if (campId) await sql`DELETE FROM campaigns WHERE id=${campId}`;
  console.log(`🧹 cleanup: ${leadIds.length} seed lead + campaign(${campId ?? 'yok'}) silindi.`);
}

async function main() {
  if (MODE === 'cleanup') { await cleanup(); await sql.end(); return; }

  const adminId = await superAdminId();
  const tpl = await sql`SELECT subject FROM email_templates WHERE id=${DMC_TEMPLATE_ID}`;
  const subject = tpl[0]?.subject ?? '(template bulunamadı)';

  console.log(`\n=== SEED INBOX TEST — mod: ${MODE.toUpperCase()} ===`);
  console.log(`Template: ${DMC_TEMPLATE_ID} | konu: "${subject}"`);
  console.log(`Provider: OUTREACH (campaign_id verildiği için → constantineyachts.online DKIM)`);
  console.log(`Gönderen: ${OUTREACH_SENDER}`);
  console.log(`Alıcılar (${SEED_EMAILS.length}): ${SEED_EMAILS.join(', ')}\n`);

  if (MODE !== 'send') {
    console.log('DRY mod — hiçbir şey gönderilmedi. Gerçek gönderim için: npx tsx scripts/seed-inbox-test.mts send');
    await sql.end();
    return;
  }

  const campId = await ensureSeedCampaign(adminId);
  const leads = await ensureSeedLeads();
  console.log(`Seed campaign: ${campId} | ${leads.length} seed lead hazır. Gönderiliyor...\n`);

  let ok = 0, fail = 0;
  for (const lead of leads) {
    try {
      const res = await sendEmailCore(
        { lead_id: lead.id, template_id: DMC_TEMPLATE_ID, sender_email: OUTREACH_SENDER, campaign_id: campId, sequence_step: 0 },
        { userId: adminId, role: 'super_admin' },
      );
      if (res.success || (res as any).deduped) {
        ok++;
        console.log(`  ✓ ${lead.email} → ${(res as any).deduped ? 'zaten gönderilmiş (dedupe)' : 'gönderildi'} ${(res as any).resend_message_id ? '('+(res as any).resend_message_id+')' : ''}`);
      } else {
        fail++;
        console.log(`  ✗ ${lead.email} → HATA: ${(res as any).error ?? 'bilinmiyor'} (status ${(res as any).status ?? '?'})`);
      }
    } catch (e: any) {
      fail++;
      console.log(`  ✗ ${lead.email} → EXCEPTION: ${e?.message}`);
    }
    await sleep(1200); // Resend 5 req/s — güvenli aralık
  }

  console.log(`\n=== ${ok} gönderildi, ${fail} hata ===`);
  console.log('Şimdi her kutuyu aç: INBOX mı SPAM mı? Render (imza/panel linki/telefon) düzgün mü?');
  console.log('Test bitince temizlik: npx tsx scripts/seed-inbox-test.mts cleanup\n');
  await sql.end();
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
