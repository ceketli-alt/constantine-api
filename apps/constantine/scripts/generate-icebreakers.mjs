#!/usr/bin/env node
/**
 * generate-icebreakers.mjs — Lead başına AI kişiselleştirilmiş açılış cümlesi (Faz 2 / G6)
 *
 * company_name / segment / konum / enrichment (source_meta) → Claude → 1 cümlelik icebreaker
 * → leads.custom_fields.ai_icebreaker. Şablonlarda {{ai_icebreaker}} ile kullanılır.
 *
 * NOT: prompt mantığı backend src/icebreaker.ts ile AYNI tutulmalı (ops script kopyası).
 *
 * Kullanım (maliyet güvenliği — biri zorunlu):
 *   node generate-icebreakers.mjs --tag seg-dmc --dry-run         # kaç lead, API call YOK
 *   node generate-icebreakers.mjs --tag seg-dmc --limit 5         # ilk 5 (test)
 *   node generate-icebreakers.mjs --tag seg-dmc --execute         # tüm seg-dmc (icebreaker'ı boş olanlar)
 *   node generate-icebreakers.mjs --limit 20                      # tag'siz, ilk 20
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import postgres from 'postgres';
import Anthropic from '@anthropic-ai/sdk';

// .env'i cwd'den bağımsız, script konumuna göre yükle (monorepo/pnpm hoisting'e dayanıklı).
// override:true ZORUNLU — sistem env'inde ANTHROPIC_API_KEY= (boş) var, yoksa .env'i ezmez (bilinen gotcha).
dotenv.config({ path: resolve(dirname(fileURLToPath(import.meta.url)), '..', '.env'), override: true });

const DATABASE_URL = process.env.DATABASE_URL;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.ANTHROPIC_DRAFT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
const GAP_MS = Number(process.env.ICEBREAKER_GAP_MS ?? 300);

if (!DATABASE_URL) { console.error('DATABASE_URL eksik (.env)'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('ANTHROPIC_API_KEY eksik (.env)'); process.exit(1); }

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valOf = (f) => { const i = argv.indexOf(f); return i > -1 ? argv[i + 1] : null; };
const dryRun = has('--dry-run');
const execute = has('--execute');
const tag = valOf('--tag');
// Çoklu tag = INTERSECTION (tags @> ARRAY[...]). Örn: --tag seg-dmc,trust-high,email-valid → tam kampanya havuzu.
const tagList = tag ? tag.split(',').map((s) => s.trim()).filter(Boolean) : [];
const limit = valOf('--limit') ? parseInt(valOf('--limit'), 10) : null;

if (!dryRun && !execute && !limit) {
  console.error('Güvenlik: --dry-run, --limit N veya --execute belirt.');
  process.exit(1);
}

const SYSTEM_PROMPT = `Sen Constantine Yachts (İstanbul Boğazı'nda B2B yat kiralama, partner programı) adına cold-outreach
maillerine kişiselleştirilmiş AÇILIŞ CÜMLESİ (icebreaker) yazan bir asistansın. Sana bir işletmenin bilgileri
verilecek; o işletmeye ÖZEL, doğal, samimi-profesyonel TEK cümlelik bir açılış üreteceksin.

ALICI KİM: İşletme bir inbound DMC / seyahat acentesidir — yurt dışından İstanbul'a misafir grupları getirir ve
onlara klasik İstanbul turları (tarihi yarımada, Boğaz, şehir turu vb.) düzenler.

⛔ KONUM TUZAĞI (en sık yapılan hata): İşletmenin ilçesi (Fatih, Şişli, Bahçelievler, Üsküdar vb.) YALNIZCA ofis
adresidir. Turlar oradan başlamaz, o ilçede yapılmaz. ASLA turu/grubu ofis ilçesine bağlama. Şunlar YASAK:
"Fatih'teki gruplarınız", "Şişli'den başlayan turlarınız", "Üsküdar'dan organize ettiğiniz", "Bahçelievler'deki operasyonlarınız".

NE YAZ: İşletmenin İSTANBUL'A getirdiği misafir gruplarına / klasik İstanbul tur programına, Boğaz'da özel bir yat
deneyimini premium bir EK (upsell) olarak konumlandıran tek cümle. Çapan firma adı ve inbound İstanbul operasyonu olsun.

İYİ ÖRNEKLER (bu çerçeve):
- "ABAYLAR TURİZM olarak İstanbul'a ağırladığınız gruplara, klasik tur programının yanında Boğaz'da özel bir yat günü eklemeyi düşündünüz mü?"
- "İstanbul inbound programlarınıza, misafirlerinizi farklılaştıracak bir Boğaz yat deneyimi katmanı eklemek ilginizi çeker mi?"
- "Yurt dışından getirdiğiniz gruplara, klasik İstanbul turunun yanında Boğaz'da premium bir yat deneyimi sunmak paketinizi öne çıkarabilir."

KÖTÜ ÖRNEKLER (ASLA böyle yazma):
- "Şişli'den başlayan turlarınız için..." ❌  - "Fatih'teki gruplarınız için..." ❌

Kurallar:
- TEK cümle, en fazla ~25 kelime, Türkçe.
- Firma adına ve/veya inbound İstanbul tur operasyonuna değin — kişiye özel hissettir.
- Klişe YASAK ("umarım iyisinizdir", "nasılsınız"). Abartı/yağcılık ve uydurma bilgi yok.
- Selamlama veya imza EKLEME (sadece açılış cümlesi). Tırnak içine alma.

Çıktı SADECE JSON: { "icebreaker": "<tek cümle>" }`;

function buildPrompt(lead) {
  const sm = lead.source_meta ?? {};
  const bits = [];
  if (lead.company_name) bits.push(`İşletme: ${lead.company_name}`);
  if (lead.website) bits.push(`Web: ${lead.website}`);
  const pt = sm.google_primary_type ?? sm.primary_type;
  if (pt) bits.push(`Kategori: ${pt}`);
  // NOT: district/city KASITLI verilmiyor — inbound DMC; ofis ilçesi tur lokasyonu DEĞİL (KONUM TUZAĞI).
  return `${bits.join('\n')}\n\nBu inbound DMC / seyahat acentesine, İstanbul'a getirdiği misafir gruplarına Boğaz yat deneyimini premium ek olarak konumlandıran TEK cümlelik açılış üret.`;
}

const sql = postgres(DATABASE_URL, { max: 2 });
const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const lim = limit ?? (execute ? 100000 : 50);
  const leads = await sql`
    SELECT id, company_name, website, city, district, segment, type, source_meta
    FROM leads
    WHERE status <> 'opted_out'
      AND COALESCE(custom_fields->>'ai_icebreaker', '') = ''
      ${tagList.length ? sql`AND tags @> ${tagList}` : sql``}
    ORDER BY score DESC NULLS LAST, created_at
    LIMIT ${lim}
  `;

  console.log(`Hedef: ${leads.length} lead${tagList.length ? ` (tags=${tagList.join('+')})` : ''}, model=${MODEL}`);
  if (dryRun) {
    console.log('--dry-run: API call yok. Örnek lead:', leads[0]?.company_name ?? '(yok)');
    await sql.end();
    return;
  }

  let ok = 0, fail = 0;
  for (const lead of leads) {
    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 200, temperature: 0.7,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildPrompt(lead) }],
      });
      const block = resp.content.find((b) => b.type === 'text');
      const text = block && 'text' in block ? block.text.trim() : '';
      const m = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(m ? m[0] : text);
      const ice = typeof parsed.icebreaker === 'string' ? parsed.icebreaker.trim() : '';
      if (!ice) { fail++; continue; }
      await sql`
        UPDATE leads
        SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || ${sql.json({ ai_icebreaker: ice })}
        WHERE id = ${lead.id}
      `;
      ok++;
      if (ok <= 5) console.log(`  ✓ ${lead.company_name}: ${ice}`);
    } catch (e) {
      fail++;
      console.warn(`  ✗ ${lead.company_name}: ${e?.message ?? e}`);
    }
    await sleep(GAP_MS);
  }
  console.log(`\nBitti: ${ok} üretildi, ${fail} hata.`);
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
