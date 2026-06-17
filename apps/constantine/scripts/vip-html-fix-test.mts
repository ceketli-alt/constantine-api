/**
 * vip-html-fix-test.mts — body_html boş + body_text dolu durumunda email-send.ts
 * fallback'inin (textToBasicHtml) çalışıp çalışmadığını test eder.
 *
 * VIP 17 mail'den birinin body_text'ini ceketli@gmail.com'a [TEST FIX] subject'iyle
 * gönderir. Bu mail gerçek VIP'lere DOKUNMAZ.
 *
 * Kullanım:
 *   npx tsx scripts/vip-html-fix-test.mts          # yelizcimen body_text örneği
 *   npx tsx scripts/vip-html-fix-test.mts <email>  # başka VIP'in body_text'i (örn. fatih@mygo.pro)
 */
import 'dotenv/config';
import { sql } from '../src/db.js';
import { sendEmailCore } from '../src/email-send.js';

const VIP_CAMPAIGN_ID = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a';
const TEST_RECIPIENT = 'ceketli@gmail.com';
const SOURCE_VIP_EMAIL = (process.argv[2] ?? 'yelizcimen@intraturkey.com').toLowerCase();

async function main() {
  const sourceRows = await sql`
    SELECT em.subject, em.body_text, em.to_email
    FROM email_messages em
    WHERE em.campaign_id = ${VIP_CAMPAIGN_ID}
      AND lower(em.to_email) = ${SOURCE_VIP_EMAIL}
    ORDER BY em.sent_at DESC LIMIT 1`;
  if (!sourceRows[0]) {
    console.error(`Kaynak bulunamadı: ${SOURCE_VIP_EMAIL}`);
    process.exit(1);
  }
  const src = sourceRows[0];

  const seedRows = await sql`
    SELECT id FROM leads WHERE lower(primary_contact_email) = ${TEST_RECIPIENT} LIMIT 1`;
  if (!seedRows[0]) {
    console.error(`Seed lead bulunamadı: ${TEST_RECIPIENT}`);
    process.exit(1);
  }
  const seedLeadId = seedRows[0].id;

  const adminRows = await sql`SELECT id FROM profiles WHERE role='super_admin' AND active=true LIMIT 1`;
  const adminId = adminRows[0].id;

  console.log(`\n=== VIP HTML FIX TEST ===`);
  console.log(`Kaynak: ${SOURCE_VIP_EMAIL} → ${src.body_text?.length ?? 0} char body_text`);
  console.log(`Hedef:  ${TEST_RECIPIENT} (seed lead ${seedLeadId})`);
  console.log(`Subject: [TEST FIX] ${src.subject}`);
  console.log(`Sender: mert@constantineyachts.online`);
  console.log(`body_html: BOŞ (fallback test) — backend textToBasicHtml() devreye girmeli\n`);

  const res = await sendEmailCore(
    {
      lead_id: seedLeadId,
      subject: `[TEST FIX] ${src.subject}`,
      body_text: src.body_text as string,
      body_html: '',                                  // ← KASITLI BOŞ
      sender_email: 'mert@constantineyachts.online',
      campaign_id: VIP_CAMPAIGN_ID,                    // ← outreach key + cy.online DKIM zorla
    },
    { userId: adminId, role: 'super_admin' },
  );

  if (res.success) {
    console.log(`✓ Gönderildi → ${(res as any).resend_message_id ?? '(id yok)'}`);
    console.log(`Mert: ceketli@gmail.com inbox'unu aç → "[TEST FIX]" mailini bul.`);
    console.log(`Beklenen: Yeliz Hanım'ın Türkçe pitch'i HTML olarak görünür (paragraph + link).`);
  } else {
    console.error(`✗ HATA:`, res);
    process.exit(1);
  }
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
