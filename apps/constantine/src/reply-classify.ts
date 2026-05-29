/**
 * /functions/v1/reply-classify — Inbound email yanıtını Claude Haiku 4.5 ile sınıflandır
 *
 * 6 kategori: hot / warm / cold / objection / opt_out / irrelevant
 *
 * Akış (Supabase fn'in Hono portu, OpenAI → Anthropic Claude):
 *  1. message_id ile email_messages fetch (direction='inbound' kontrol)
 *  2. Claude messages.create (Haiku 4.5, JSON response, TR system prompt)
 *  3. email_threads.classification + classified_at güncelle
 *  4. leads.temperature map (hot/warm/cold)
 *  5. opt_out → leads.status='opted_out' + unsubscribes upsert + thread closed
 *  6. activity_events insert (reply_classified)
 *
 * Bu endpoint genelde fire-and-forget olarak email-inbound tarafından çağrılır.
 * UI'dan da manuel "yeniden sınıflandır" akışı için çağrılabilir (auth gerekli olur).
 */
import type { Context } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { sql } from './db.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sen Türk B2B mail yanıtlarını sınıflandıran bir asistansın.
Aşağıdaki müşteri yanıtını şu kategorilerden BİRİNE ata ve kısa bir gerekçe yaz:

- hot: Görüşme/teklif/fiyat soruyor, satın alma sinyali güçlü. Örnek: "Ne zaman aktif olur?", "Fiyat listesi gönderir misiniz?", "Toplantı ayarlayalım"
- warm: İlgili ama netleştirme istiyor. Örnek: "Hangi tekneleriniz var?", "Kapasite nedir?", "Bilgi alabilir miyim?"
- cold: Kibar ret veya "şimdi değil". Örnek: "Teşekkürler, ilgilenmiyoruz", "İleride değerlendiririz", "Bizde yoğunluk var"
- objection: Net itiraz. Örnek: "Pahalı", "Rakipte daha uygun", "Şartlar bizim için uygun değil"
- opt_out: Listeden çıkmak istiyor (KVKK). Örnek: "Mail göndermeyin", "Abonelik iptali", "Beni listeden çıkarın"
- irrelevant: OOO, autoreply, alakasız, robot yanıt. Örnek: "Out of office", "Bu adres pasif", spam-like

Çıktı SADECE JSON:
{ "classification": "<kategori>", "confidence": 0.0-1.0, "reasoning": "<1 cümle Türkçe>" }`;

export interface ClassifyRequest {
  thread_id?: string;
  message_id: string;
  lead_id?: string;
}

const VALID_CLASSES = ['hot', 'warm', 'cold', 'objection', 'opt_out', 'irrelevant'] as const;
type Classification = typeof VALID_CLASSES[number];

interface ClassifyResult {
  classification: Classification;
  confidence: number;
  reasoning: string;
}

export type RunReplyClassifyResult =
  | { ok: true; classification: Classification; confidence: number; reasoning: string }
  | { ok: false; status: number; error: string; detail?: string };

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Core classify logic — Context'siz, in-process çağrılabilir.
 *  Backend B7: email-inbound bu fonksiyonu doğrudan çağırır (eskiden HTTP self-loop'tu). */
export async function runReplyClassify(input: ClassifyRequest): Promise<RunReplyClassifyResult> {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, status: 503, error: 'reply-classify unconfigured — ANTHROPIC_API_KEY env eksik' };
  }
  if (!input.message_id) {
    return { ok: false, status: 400, error: 'message_id required' };
  }

  try {
    // 1. Message fetch
    const msgRows = await sql`
      SELECT id, thread_id, body_text, body_html, subject, direction
      FROM email_messages
      WHERE id = ${input.message_id}
      LIMIT 1
    `;
    const msg = msgRows[0];
    if (!msg) {
      return { ok: false, status: 404, error: 'Message bulunamadı' };
    }
    if (msg.direction !== 'inbound') {
      return { ok: false, status: 400, error: 'Sadece inbound mesajlar sınıflandırılır' };
    }

    const rawText = (msg.body_text ?? stripHtml(msg.body_html ?? '')).slice(0, 4000);
    if (!rawText.trim()) {
      return { ok: false, status: 400, error: 'Mesaj boş, sınıflandırılamaz' };
    }

    // 2. Claude classify
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    let classification: ClassifyResult;
    try {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 200,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Subject: ${msg.subject}\n\nBody:\n${rawText}`,
          },
        ],
      });
      const block = response.content.find((b) => b.type === 'text');
      const text = block && 'text' in block ? block.text.trim() : '';
      // Claude bazen markdown code fence'lı dönebilir — sadece JSON çıkar
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const jsonStr = jsonMatch ? jsonMatch[0] : text;
      classification = JSON.parse(jsonStr) as ClassifyResult;
    } catch (e: any) {
      console.error('[reply-classify] Claude error:', e?.message);
      return { ok: false, status: 500, error: 'Claude API hatası', detail: e?.message };
    }

    if (!VALID_CLASSES.includes(classification.classification)) {
      return { ok: false, status: 500, error: 'invalid_classification', detail: JSON.stringify(classification) };
    }

    const nowIso = new Date().toISOString();

    // 3. Thread update
    await sql`
      UPDATE email_threads
      SET classification = ${classification.classification}::email_classification,
          classified_at = ${nowIso}
      WHERE id = ${msg.thread_id}
    `;

    // 4. Lead temperature map
    const tempMap: Record<Classification, string | null> = {
      hot: 'hot',
      warm: 'warm',
      cold: 'cold',
      objection: 'cold',
      opt_out: null,
      irrelevant: null,
    };
    const newTemp = tempMap[classification.classification];

    const threadRows = await sql`
      SELECT lead_id FROM email_threads WHERE id = ${msg.thread_id}
    `;
    const leadId = threadRows[0]?.lead_id;

    if (leadId) {
      // Lead update
      if (classification.classification === 'opt_out') {
        await sql`
          UPDATE leads
          SET status = 'opted_out'
          WHERE id = ${leadId}
        `;
      } else if (newTemp) {
        await sql`
          UPDATE leads
          SET temperature = ${newTemp}::lead_temperature
          WHERE id = ${leadId}
        `;
      }

      // 5. opt_out → unsubscribes upsert + thread closed
      if (classification.classification === 'opt_out') {
        const leadRows = await sql`
          SELECT primary_contact_email FROM leads WHERE id = ${leadId}
        `;
        const email = leadRows[0]?.primary_contact_email;
        if (email) {
          try {
            await sql`
              INSERT INTO unsubscribes (channel, identifier, reason, source)
              VALUES ('email', ${email}, 'auto_classified_reply', 'reply_classify')
              ON CONFLICT (channel, identifier) DO UPDATE
                SET reason = EXCLUDED.reason, source = EXCLUDED.source
            `;
          } catch (e: any) {
            // ON CONFLICT için unique constraint olması gerekir, yoksa simple insert fallback
            console.warn('[reply-classify] unsubscribes upsert fallback:', e.message);
            try {
              const existing = await sql`
                SELECT id FROM unsubscribes
                WHERE channel = 'email' AND identifier = ${email}
                LIMIT 1
              `;
              if (existing.length === 0) {
                await sql`
                  INSERT INTO unsubscribes (channel, identifier, reason, source)
                  VALUES ('email', ${email}, 'auto_classified_reply', 'reply_classify')
                `;
              }
            } catch (e2: any) {
              console.error('[reply-classify] unsubscribes insert failed:', e2.message);
            }
          }
        }
        await sql`
          UPDATE email_threads SET status = 'closed' WHERE id = ${msg.thread_id}
        `;
      }

      // 6. activity_events
      try {
        const adminRows = await sql`
          SELECT id FROM profiles
          WHERE role = 'super_admin' AND active = true
          ORDER BY created_at LIMIT 1
        `;
        const adminId = adminRows[0]?.id;
        if (adminId) {
          await sql`
            INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
            VALUES (
              ${adminId}::uuid, 'reply_classified', 'standard', 0, 'lead', ${leadId}::uuid,
              ${sql.json({
                thread_id: msg.thread_id,
                message_id: input.message_id,
                classification: classification.classification,
                confidence: classification.confidence,
                reasoning: classification.reasoning,
              })}
            )
          `;
        }
      } catch (e: any) {
        console.warn('[reply-classify] activity_events insert skipped:', e.message);
      }
    }

    return {
      ok: true,
      classification: classification.classification,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
    };
  } catch (e: any) {
    console.error('[reply-classify] unhandled:', e);
    return { ok: false, status: 500, error: 'internal_error', detail: e?.message ?? 'unknown' };
  }
}

/** HTTP wrapper — Context'ten body parse eder, runReplyClassify çağırır, JSON serialize. */
export async function handleReplyClassify(c: Context): Promise<Response> {
  let body: ClassifyRequest;
  try {
    body = await c.req.json() as ClassifyRequest;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const r = await runReplyClassify(body);
  if (!r.ok) {
    return c.json({ error: r.error, detail: r.detail }, r.status as 400 | 404 | 500 | 503);
  }
  return c.json({
    success: true,
    classification: r.classification,
    confidence: r.confidence,
    reasoning: r.reasoning,
  });
}
