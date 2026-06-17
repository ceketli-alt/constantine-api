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

Sınıflandırmayı her zaman classify_reply aracını çağırarak döndür.`;

// Structured output — Claude JSON string yerine tool parametresi üretir → SDK
// garantili-valid obje döner. reasoning içindeki tırnak/alıntı artık JSON'u bozmaz
// (eski text+JSON.parse yaklaşımı "position 98" parse hatası veriyordu).
const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_reply',
  description: 'Müşteri mail yanıtını 6 kategoriden birine sınıflandırır.',
  input_schema: {
    type: 'object',
    properties: {
      classification: {
        type: 'string',
        enum: ['hot', 'warm', 'cold', 'objection', 'opt_out', 'irrelevant'],
        description: 'Yanıt kategorisi',
      },
      confidence: { type: 'number', description: '0.0-1.0 arası güven skoru' },
      reasoning: { type: 'string', description: '1 cümle Türkçe gerekçe' },
    },
    required: ['classification', 'confidence', 'reasoning'],
  },
};

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

    // msg.subject narrowing'ini nested closure'a taşımadan önce sabitle (TS18048).
    const userContent = `Subject: ${msg.subject}\n\nBody:\n${rawText}`;

    // Tek sınıflandırma denemesi — tool use ile garantili-valid structured output.
    async function classifyOnce(): Promise<ClassifyResult> {
      const response = await client.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 600,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        tools: [CLASSIFY_TOOL],
        tool_choice: { type: 'tool', name: 'classify_reply' },
        messages: [
          {
            role: 'user',
            content: userContent,
          },
        ],
      });
      const toolBlock = response.content.find((b) => b.type === 'tool_use');
      if (!toolBlock || !('input' in toolBlock)) {
        throw new Error('classify_reply tool_use block dönmedi');
      }
      return toolBlock.input as ClassifyResult;
    }

    let classification: ClassifyResult;
    try {
      // İlk deneme parse/transient hatası verirse 1 kez daha dene (idempotent — sadece okuma).
      try {
        classification = await classifyOnce();
      } catch (firstErr: any) {
        console.warn('[reply-classify] ilk deneme başarısız, retry:', firstErr?.message);
        classification = await classifyOnce();
      }
    } catch (e: any) {
      console.error('[reply-classify] Claude error (2 deneme sonrası):', e?.message);
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
        // Lead snapshot (deal_id + status — Faz B kararları için)
        const leadRows = await sql<Array<{ deal_id: string | null; status: string; company_name: string | null; primary_contact_name: string | null }>>`
          SELECT deal_id, status::text AS status, company_name, primary_contact_name
          FROM leads WHERE id = ${leadId}
        `;
        const lead = leadRows[0];

        await sql`
          UPDATE leads
          SET temperature = ${newTemp}::lead_temperature
          WHERE id = ${leadId}
        `;

        // ─── Faz B1 — Hot reply → auto-deal ─────────────────────────
        // Koşullar: classification='hot' + lead.deal_id IS NULL + thread'in son outbound
        // campaign'ı auto_create_deal_on_hot_reply=true. Idempotent: deal_id guard.
        if (classification.classification === 'hot' && lead && lead.deal_id == null) {
          try {
            type CampRow = {
              campaign_id: string;
              campaign_name: string | null;
              auto_create_deal_on_hot_reply: boolean;
              auto_deal_min_confidence: number;
              created_by: string | null;
            };

            // 1) Önce thread-bazlı: reply'ın thread'inde campaign'li outbound var mı?
            //    (Threading düzgün çalıştığında en kesin atıf budur.)
            const threadCampRows = await sql<Array<CampRow>>`
              SELECT em.campaign_id,
                     c.name                            AS campaign_name,
                     c.auto_create_deal_on_hot_reply,
                     c.auto_deal_min_confidence,
                     c.created_by
              FROM email_messages em
              LEFT JOIN campaigns c ON c.id = em.campaign_id
              WHERE em.thread_id = ${msg.thread_id}
                AND em.direction = 'outbound'
                AND em.campaign_id IS NOT NULL
              ORDER BY em.sent_at DESC NULLS LAST
              LIMIT 1
            `;
            let camp = threadCampRows[0];

            // 2) Lead-bazlı fallback: reply yeni/ayrı bir thread'e düştüyse (Mailcow
            //    threading kırık — outbound message_id_header NULL, in_reply_to eşleşmiyor),
            //    thread'de campaign bulunmaz. campaign_targets.replied zaten lead-bazlı
            //    set ediliyor; auto-deal de aynı kaynağı kullansın: lead'in EN SON mail
            //    aldığı kampanya.
            if (!camp) {
              const leadCampRows = await sql<Array<CampRow>>`
                SELECT ct.campaign_id,
                       c.name                            AS campaign_name,
                       c.auto_create_deal_on_hot_reply,
                       c.auto_deal_min_confidence,
                       c.created_by
                FROM campaign_targets ct
                JOIN campaigns c ON c.id = ct.campaign_id
                WHERE ct.lead_id = ${leadId}
                  AND ct.sent_at IS NOT NULL
                ORDER BY ct.sent_at DESC NULLS LAST, ct.created_at DESC
                LIMIT 1
              `;
              camp = leadCampRows[0];
              if (camp) {
                console.log(`[reply-classify] auto-deal: thread'de campaign yok, lead-bazlı fallback → campaign=${camp.campaign_id} (lead=${leadId})`);
              }
            }

            // D2 — confidence guard: Claude eşik altındaysa deal AÇILMAZ (temperature yine güncellendi).
            const minConf = Number(camp?.auto_deal_min_confidence ?? 0.7);
            const replyConf = Number(classification.confidence ?? 0);
            const confidencePass = replyConf >= minConf;
            if (camp && camp.auto_create_deal_on_hot_reply === true && !confidencePass) {
              console.log(`[reply-classify] auto-deal skipped: confidence ${replyConf.toFixed(2)} < threshold ${minConf.toFixed(2)} (campaign=${camp.campaign_id})`);
              try {
                const adminId =
                  camp.created_by ??
                  (await sql<Array<{ id: string }>>`
                    SELECT id FROM profiles WHERE role = 'super_admin' AND active = true
                    ORDER BY created_at LIMIT 1
                  `)[0]?.id;
                if (adminId) {
                  await sql`
                    INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
                    VALUES (
                      ${adminId}::uuid,
                      'deal_auto_skipped_low_confidence',
                      'standard',
                      0,
                      'lead',
                      ${leadId}::uuid,
                      ${sql.json({
                        campaign_id: camp.campaign_id,
                        campaign_name: camp.campaign_name,
                        confidence: replyConf,
                        threshold: minConf,
                        reasoning: classification.reasoning,
                        reply_message_id: input.message_id,
                        thread_id: msg.thread_id,
                      })}
                    )
                  `;
                }
              } catch (e: any) {
                console.warn('[reply-classify] skip-event insert failed:', e?.message);
              }
            }

            if (camp && camp.auto_create_deal_on_hot_reply === true && confidencePass) {
              const stageRows = await sql<Array<{ id: string }>>`
                SELECT id FROM deal_stages WHERE slug = 'qualified' LIMIT 1
              `;
              const stageId = stageRows[0]?.id ?? null;

              if (stageId) {
                const displayName = lead.company_name ?? lead.primary_contact_name ?? 'Lead';
                const title = `${displayName} — ${camp.campaign_name ?? 'Reply'}`;
                const notes = `Otomatik: "${camp.campaign_name ?? 'kampanya'}" kampanyasında 'hot' reply. Subject: ${msg.subject ?? ''}`;

                const dealRows = await sql<Array<{ id: string }>>`
                  INSERT INTO deals (lead_id, title, stage_id, probability, owner_id, source_channel, notes)
                  VALUES (
                    ${leadId}::uuid,
                    ${title},
                    ${stageId}::uuid,
                    35,
                    ${camp.created_by}::uuid,
                    'email'::contact_channel,
                    ${notes}
                  )
                  RETURNING id
                `;
                const dealId = dealRows[0]?.id ?? null;

                if (dealId) {
                  await sql`
                    UPDATE leads
                    SET deal_id = ${dealId}::uuid,
                        status  = 'qualified'
                    WHERE id = ${leadId}
                  `;

                  // activity_events: deal_auto_created
                  try {
                    const adminId =
                      camp.created_by ??
                      (await sql<Array<{ id: string }>>`
                        SELECT id FROM profiles WHERE role = 'super_admin' AND active = true
                        ORDER BY created_at LIMIT 1
                      `)[0]?.id;
                    if (adminId) {
                      await sql`
                        INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
                        VALUES (
                          ${adminId}::uuid,
                          'deal_auto_created',
                          'standard',
                          0,
                          'deal',
                          ${dealId}::uuid,
                          ${sql.json({
                            campaign_id: camp.campaign_id,
                            campaign_name: camp.campaign_name,
                            lead_id: leadId,
                            temperature: 'hot',
                            confidence: replyConf,
                            threshold: minConf,
                            reply_message_id: input.message_id,
                            thread_id: msg.thread_id,
                          })}
                        )
                      `;
                    }
                  } catch (e: any) {
                    console.warn('[reply-classify] deal_auto_created activity skipped:', e.message);
                  }
                }
              } else {
                console.warn('[reply-classify] auto-deal: qualified stage bulunamadı');
              }
            }
          } catch (e: any) {
            // Auto-deal başarısız olsa da temperature update commit kalır
            console.error('[reply-classify] auto-deal create FAILED (non-fatal):', e?.message);
          }
        }

        // ─── Faz B2 — Warm reply → status='in_dialogue' ─────────────
        // Koşul: classification='warm' + lead.status='contacted' (henüz qualified+ olmadıysa)
        else if (classification.classification === 'warm' && lead && lead.status === 'contacted') {
          try {
            await sql`
              UPDATE leads SET status = 'in_dialogue' WHERE id = ${leadId}
            `;
            const adminId = (await sql<Array<{ id: string }>>`
              SELECT id FROM profiles WHERE role = 'super_admin' AND active = true
              ORDER BY created_at LIMIT 1
            `)[0]?.id;
            if (adminId) {
              await sql`
                INSERT INTO activity_events (user_id, event_type, category, points, target_type, target_id, metadata)
                VALUES (
                  ${adminId}::uuid,
                  'lead_status_changed',
                  'standard',
                  0,
                  'lead',
                  ${leadId}::uuid,
                  ${sql.json({
                    from: 'contacted',
                    to: 'in_dialogue',
                    reason: 'warm_reply',
                    message_id: input.message_id,
                    thread_id: msg.thread_id,
                  })}
                )
              `;
            }
          } catch (e: any) {
            console.warn('[reply-classify] in_dialogue transition skipped:', e?.message);
          }
        }
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
