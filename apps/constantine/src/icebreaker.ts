/**
 * /functions/v1/generate-icebreaker — Lead başına kişiselleştirilmiş AÇILIŞ CÜMLESİ üret (Faz 2 / G6)
 *
 * Instantly "AI personalization" muadili. Lead'in company_name / website / enrichment (source_meta)
 * verisinden 1 cümlelik doğal bir icebreaker üretir, `leads.custom_fields.ai_icebreaker`'a yazar.
 * Template'lerde `{{ai_icebreaker}}` ile kullanılır (email-send vars'a eklendi).
 *
 * Batch: body { lead_ids: [...] } veya { tag, limit }. Rate-limit'e saygılı (ardışık gap).
 * Pre-generate edilir (gönderim anında değil) → gönderim hızlı + maliyet kontrollü.
 */
import type { Context } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ICEBREAKER_MODEL = process.env.ANTHROPIC_DRAFT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

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

export interface IcebreakerLead {
  company_name?: string | null;
  website?: string | null;
  city?: string | null;
  district?: string | null;
  segment?: string | null;
  type?: string | null;
  source_meta?: any;
}

/** Claude user prompt'unu kur — PURE (test edilebilir). */
export function buildIcebreakerPrompt(lead: IcebreakerLead): string {
  const sm = (lead.source_meta ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (lead.company_name) bits.push(`İşletme: ${lead.company_name}`);
  if (lead.website) bits.push(`Web: ${lead.website}`);
  const primaryType = sm.google_primary_type ?? sm.primary_type;
  if (primaryType) bits.push(`Kategori: ${String(primaryType)}`);
  // NOT: district/city KASITLI verilmiyor — bu firmalar inbound DMC; ofis ilçesi turun
  // yapıldığı yer DEĞİL. Konumu açılışa sokmak "işini anlamamışlar" sinyali verir (system prompt'taki KONUM TUZAĞI).
  return `${bits.join('\n')}\n\nBu inbound DMC / seyahat acentesine, İstanbul'a getirdiği misafir gruplarına Boğaz yat deneyimini premium ek olarak konumlandıran TEK cümlelik açılış üret.`;
}

/** Tek lead için icebreaker üret (Claude). Context'siz, in-process çağrılabilir. */
export async function generateIcebreaker(lead: IcebreakerLead): Promise<{ ok: boolean; icebreaker?: string; error?: string }> {
  if (!ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY env eksik' };
  try {
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    const response = await client.messages.create({
      model: ICEBREAKER_MODEL,
      max_tokens: 200,
      temperature: 0.7,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildIcebreakerPrompt(lead) }],
    });
    const block = response.content.find((b) => b.type === 'text');
    const text = block && 'text' in block ? block.text.trim() : '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    const ice = typeof parsed.icebreaker === 'string' ? parsed.icebreaker.trim() : '';
    if (!ice) return { ok: false, error: 'empty_icebreaker' };
    return { ok: true, icebreaker: ice };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'claude_error' };
  }
}

const GEN_GAP_MS = Number(process.env.ICEBREAKER_GAP_MS ?? 300);
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

/** HTTP handler — auth'lu. Body: { lead_ids?: string[] } VEYA { tag?: string, limit?: number }. */
export async function handleGenerateIcebreaker(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'Auth gerek' }, 401);
  if (!ANTHROPIC_API_KEY) return c.json({ error: 'ANTHROPIC_API_KEY env eksik' }, 503);

  let body: { lead_ids?: string[]; tag?: string; limit?: number };
  try {
    body = (await c.req.json()) as any;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }

  // Hedef lead seti
  let leads: any[];
  if (Array.isArray(body.lead_ids) && body.lead_ids.length > 0) {
    leads = await sql`
      SELECT id, company_name, website, city, district, segment, type, source_meta, custom_fields
      FROM leads WHERE id = ANY(${body.lead_ids as any})
    `;
  } else {
    const limit = Math.min(Math.max(1, Number(body.limit ?? 50)), 500);
    leads = body.tag
      ? await sql`
          SELECT id, company_name, website, city, district, segment, type, source_meta, custom_fields
          FROM leads
          WHERE ${body.tag} = ANY(tags) AND status <> 'opted_out'
            AND COALESCE(custom_fields->>'ai_icebreaker','') = ''
          ORDER BY created_at LIMIT ${limit}
        `
      : await sql`
          SELECT id, company_name, website, city, district, segment, type, source_meta, custom_fields
          FROM leads
          WHERE status <> 'opted_out' AND COALESCE(custom_fields->>'ai_icebreaker','') = ''
          ORDER BY created_at LIMIT ${limit}
        `;
  }

  let generated = 0;
  const failures: Array<{ id: string; error: string }> = [];
  for (const lead of leads) {
    const r = await generateIcebreaker(lead);
    if (r.ok && r.icebreaker) {
      await sql`
        UPDATE leads
        SET custom_fields = COALESCE(custom_fields, '{}'::jsonb) || ${sql.json({ ai_icebreaker: r.icebreaker })}
        WHERE id = ${lead.id}
      `;
      generated++;
    } else {
      failures.push({ id: lead.id, error: r.error ?? 'unknown' });
    }
    await sleep(GEN_GAP_MS);
  }

  return c.json({ success: true, total: leads.length, generated, failed: failures.length, failures: failures.slice(0, 20) });
}
