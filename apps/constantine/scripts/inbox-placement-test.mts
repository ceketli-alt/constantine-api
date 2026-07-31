/**
 * inbox-placement-test.mts — Instantly Inbox Placement testi için seed gönderim
 *
 * Akış: Instantly UI'de Inbox Placement → Outside Instantly → 50 seed inbox + tracking code.
 * Bu script DMC template'i (9 Haz'da gidecek mail) render edip o 50 seed inbox'a
 * outreach@cy.online'dan gönderir. Instantly placement raporu ~30 dk içinde gelir.
 *
 * Production parity: sendEmailCore çağrılır (worker yolu) → campaign_id verildiği için
 * provider=outreach (constantineyachts.online DKIM, Resend outreach key).
 *
 * Modlar:
 *   (arg yok)            → DRY: render önizlemesi + plan
 *   npx tsx scripts/inbox-placement-test.mts send     → 50 seed inbox'a gönder
 *   npx tsx scripts/inbox-placement-test.mts cleanup  → temizlik
 */
import 'dotenv/config';
import { sql } from '../src/db.js';
import { sendEmailCore } from '../src/email-send.js';

// GlockApps Manual Test "DMC Phase 2 Microsoft mert@" (2026-06-22) — 30 seed, Gmail+Outlook+Hotmail+EOP
const TRACKING_CODE = 'id: 2026-06-22-13:56:11:341t';
const SEED_INBOXES = [
  // Gmail (10)
  'cierawilliamsonwq@gmail.com','dorothypp564@gmail.com','edwardmflannery@gmail.com','jimmyrushkerk@gmail.com',
  'joanyedonald@gmail.com','earleenwhudson@gmail.com','melissaamy5465@gmail.com','kathleentratliff@gmail.com',
  'georgewsack@gmail.com','jerrybrucedath@gmail.com',
  // Outlook (7)
  'genryjobson@outlook.com','jamiecrabson@outlook.com','shannongreerf@outlook.com','jeremycworley@outlook.com',
  'marionrblack@outlook.com','williegarciaee@outlook.com','sinkerfiil@outlook.com',
  // Hotmail (4)
  'phhhillipwiligams@hotmail.com','justinjacobsdj@hotmail.com','charlettevus@hotmail.com','sheilasmithse@hotmail.com',
  // EOP / kurumsal (4)
  'elizabeaver@auth.glockdb.com','paul@userflowhq.com','alfredohoffman@fastdirectorysubmitter.com','allanb@glockapps.awsapps.com',
  // Yahoo/AOL/iCloud (5)
  'leoefraser@yahoo.com','luanajortega@yahoo.com','dannakbond@aol.com','candacechall@aol.com','romanespor11@icloud.com',
];

const DMC_TEMPLATE_ID = '3a32c3a6-01c6-4d3c-a89d-2226e0df242b';
// SEND_AS env ile gönderici override (mert@ vs outreach@ karşılaştırması). Kampanya adı sender-spesifik → dedupe çakışmaz.
const OUTREACH_SENDER = (process.env.SEND_AS ?? 'outreach@constantineyachts.online').trim();
const SENDER_TAG = OUTREACH_SENDER.split('@')[0];
const SEED_CAMPAIGN_NAME = `ZZ INBOX PLACEMENT [${SENDER_TAG}] (silinebilir)`;
// SEND_GAP_MS env: gönderimler arası bekleme (ms). 30 seed × 240000 (4dk) ≈ 2 saate yayar. Default 800 (rate-limit).
const SEND_GAP_MS = Number(process.env.SEND_GAP_MS ?? 800);
const SEED_TAG = 'zz-placement-test';
const REP_NAME = 'Mert Ödemiş';

const MODE = (process.argv[2] ?? 'dry').toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spintax: {a|b|c} → rastgele seç. mustache {{x}} korunur. */
function resolveSpintax(text: string, rng: () => number): string {
  // Sadece pipe içerenleri çöz; nested loop ile.
  const re = /\{([^{}]*\|[^{}]*)\}/g;
  let prev = '';
  let curr = text;
  while (curr !== prev) {
    prev = curr;
    curr = curr.replace(re, (_match, body: string) => {
      const opts = body.split('|');
      return opts[Math.floor(rng() * opts.length)];
    });
  }
  return curr;
}

/** Mustache: {{key}} → values[key] */
function renderMustache(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => values[k] ?? `{{${k}}}`);
}

async function superAdminId(): Promise<string> {
  const rows = await sql`SELECT id FROM profiles WHERE role='super_admin' AND active=true ORDER BY created_at LIMIT 1`;
  if (!rows[0]?.id) throw new Error('super_admin profil yok');
  return rows[0].id;
}

async function ensureSeedCampaign(adminId: string): Promise<string> {
  const found = await sql`SELECT id FROM campaigns WHERE name=${SEED_CAMPAIGN_NAME} LIMIT 1`;
  if (found[0]?.id) return found[0].id;
  const ins = await sql`
    INSERT INTO campaigns (name, description, channel, template_id, sender_email, status, daily_cap, created_by)
    VALUES (${SEED_CAMPAIGN_NAME},
            'Inbox Placement testi (Instantly) — ' || ${TRACKING_CODE} || '. Silinebilir.',
            'email', ${DMC_TEMPLATE_ID}, ${OUTREACH_SENDER}, 'draft', 0, ${adminId})
    RETURNING id`;
  return ins[0].id;
}

async function ensureSeedLeads(): Promise<{ id: string; email: string }[]> {
  const out: { id: string; email: string }[] = [];
  for (const email of SEED_INBOXES) {
    const existing = await sql`
      SELECT id FROM leads
      WHERE lower(primary_contact_email)=lower(${email}) AND ${SEED_TAG} = ANY(tags)
      LIMIT 1`;
    if (existing[0]?.id) { out.push({ id: existing[0].id, email }); continue; }
    const ins = await sql`
      INSERT INTO leads (company_name, primary_contact_email, primary_contact_name, type, segment, source, status, tags)
      VALUES (
        'Instantly Seed Inbox', ${email}, 'Seed',
        (SELECT enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid=t.oid WHERE t.typname='lead_type' LIMIT 1)::lead_type,
        'dmc'::lead_segment, 'placement-test', 'new', ARRAY[${SEED_TAG}]::text[]
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

async function loadRenderValues(): Promise<Record<string, string>> {
  const cfg = await sql`SELECT key, value FROM app_config WHERE key IN ('sales.rep_phone','sales.agency_panel_url')`;
  const map: Record<string, string> = {};
  for (const r of cfg) map[r.key] = String(r.value).replace(/^"|"$/g, '');
  const phone = map['sales.rep_phone'] ?? '+905016219413';
  const panel = map['sales.agency_panel_url'] ?? 'https://acente.constantineyachts.com';
  return {
    rep_name: REP_NAME,
    rep_phone: phone,
    rep_whatsapp_url: `https://wa.me/${phone.replace(/[^0-9]/g, '')}`,
    agency_panel_url: panel,
    primary_contact_name: 'Seed',
  };
}

async function main() {
  if (MODE === 'cleanup') { await cleanup(); await sql.end(); return; }

  const adminId = await superAdminId();
  const tpl = await sql`SELECT subject, body_html, body_text FROM email_templates WHERE id=${DMC_TEMPLATE_ID}`;
  if (!tpl[0]) throw new Error('Template bulunamadı');

  const values = await loadRenderValues();
  // Deterministic rng — bir varyant seçilsin, tüm seed'lere aynı render gitsin (placement = sabit content)
  let seed = 42;
  const rng = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };

  const subject = tpl[0].subject as string;
  const bodyHtmlRendered = renderMustache(resolveSpintax(tpl[0].body_html as string, rng), values);
  const bodyTextRendered = renderMustache(resolveSpintax(tpl[0].body_text as string, rng), values);

  // Tracking code injection — body sonuna
  const trackingHtml = `<div style="display:none;font-size:1px;line-height:0;color:#ffffff;mso-hide:all">${TRACKING_CODE}</div>`;
  const bodyHtmlFinal = bodyHtmlRendered + trackingHtml;
  const bodyTextFinal = bodyTextRendered + `\n\n${TRACKING_CODE}`;

  console.log(`\n=== INBOX PLACEMENT — mod: ${MODE.toUpperCase()} ===`);
  console.log(`Test: Instantly Inbox Placement`);
  console.log(`Tracking: ${TRACKING_CODE}`);
  console.log(`Sender: ${OUTREACH_SENDER} (outreach key, cy.online DKIM)`);
  console.log(`Subject: "${subject}"`);
  console.log(`Seed inbox: ${SEED_INBOXES.length}`);
  console.log(`\n--- BODY TEXT ÖNİZLEME ---\n${bodyTextFinal.substring(0, 800)}...\n--- ---\n`);

  if (MODE !== 'send') {
    console.log('DRY mod — hiçbir şey gönderilmedi. Gerçek: npx tsx scripts/inbox-placement-test.mts send');
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
        {
          lead_id: lead.id,
          campaign_id: campId,
          sender_email: OUTREACH_SENDER,
          subject,
          body_html: bodyHtmlFinal,
          body_text: bodyTextFinal,
          sequence_step: 0,
        },
        { userId: adminId, role: 'super_admin' },
      );
      if (res.success || (res as any).deduped) {
        ok++;
        console.log(`  ✓ ${lead.email} → ${(res as any).deduped ? 'dedupe' : 'gönderildi'} ${(res as any).resend_message_id ?? ''}`);
      } else {
        fail++;
        console.log(`  ✗ ${lead.email} → HATA: ${(res as any).error ?? '?'} (status ${(res as any).status ?? '?'})`);
      }
    } catch (e: any) {
      fail++;
      console.log(`  ✗ ${lead.email} → EXCEPTION: ${e?.message}`);
    }
    await sleep(SEND_GAP_MS); // SEND_GAP_MS ile ayarlanır (default 800; 2-saate-yay için 240000)
  }

  console.log(`\n=== ${ok} gönderildi, ${fail} hata ===`);
  console.log('Instantly dashboard ~30 dk içinde placement raporu üretir.');
  console.log('Temizlik: npx tsx scripts/inbox-placement-test.mts cleanup\n');
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
