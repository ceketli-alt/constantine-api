/**
 * /functions/v1/reply-draft — Inbound yanıta Claude ile YANIT TASLAĞI üret (Faz 2 / G5)
 *
 * Instantly "AI Reply Agent" muadili ama HUMAN-IN-THE-LOOP: taslak üretir, GÖNDERMEZ.
 * Mert Unibox/ReplyComposer'da taslağı görür, düzenler, kendisi gönderir.
 *
 * reply-classify.ts deseni: in-process `runReplyDraft` + HTTP `handleReplyDraft` (auth'lu).
 * Model: ANTHROPIC_DRAFT_MODEL || ANTHROPIC_MODEL (default Haiku — Mert düzenlediği için yeterli).
 */
import type { Context } from 'hono';
import Anthropic from '@anthropic-ai/sdk';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const DRAFT_MODEL = process.env.ANTHROPIC_DRAFT_MODEL || process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `Sen Constantine Yachts (İstanbul Boğaz yat kiralama, B2B partner programı) adına yanıt yazan
profesyonel bir satış asistanısın. Sana bir e-posta yazışması ve lead bilgisi verilecek; SON gelen müşteri
yanıtına uygun, kısa (3-6 cümle), net ve aksiyona yönlendiren YANIT TASLAKLARI üreteceksin.

Kurallar:
- Dil: istenen dil (varsayılan Türkçe). Ton: istenen ton (varsayılan profesyonel-samimi).
- Selamlama "Merhaba {ad}" tarzı. İmza ekleme (sistem ekler).
- Somut bir sonraki adım öner (kısa görüşme / WhatsApp / fiyat-müsaitlik paylaşımı).
- Uydurma fiyat/tarih/söz verme; belirsizse "paylaşalım/görüşelim" de.
- Spam tetikleyici (BÜYÜK HARF, !!!, "ücretsiz!!!") kullanma.

Çıktı SADECE JSON:
{ "drafts": ["<taslak 1>", "<taslak 2>"] }
İki kısa alternatif üret (biri daha kısa/direkt, biri biraz daha açıklayıcı).`;

export interface ReplyDraftRequest {
  thread_id?: string;
  message_id?: string;
  tone?: string;
  language?: string;
  instructions?: string;
}

export type RunReplyDraftResult =
  | { ok: true; drafts: string[]; model: string }
  | { ok: false; status: number; error: string; detail?: string };

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ThreadMessageCtx {
  direction: string;
  from_name?: string | null;
  body: string;
  created_at?: string;
}

/**
 * Claude'a verilecek user prompt'unu kur — PURE (test edilebilir, Claude'suz).
 * Son inbound vurgulanır; thread geçmişi (son ~6 mesaj) kısaltılarak verilir.
 */
export function buildDraftUserPrompt(args: {
  company?: string | null;
  contact?: string | null;
  subject?: string | null;
  messages: ThreadMessageCtx[];
  tone?: string;
  language?: string;
  instructions?: string;
}): string {
  const tone = args.tone?.trim() || 'profesyonel-samimi';
  const language = args.language?.trim() || 'Türkçe';
  const history = args.messages
    .slice(-6)
    .map((m) => {
      const who = m.direction === 'inbound' ? `MÜŞTERİ${m.from_name ? ' (' + m.from_name + ')' : ''}` : 'BİZ';
      return `[${who}]: ${m.body.slice(0, 1200)}`;
    })
    .join('\n\n');
  const extra = args.instructions?.trim() ? `\n\nEk talimat: ${args.instructions.trim()}` : '';
  return [
    `Şirket: ${args.company ?? '-'}`,
    `İlgili kişi: ${args.contact ?? '-'}`,
    `Konu: ${args.subject ?? '-'}`,
    `İstenen dil: ${language} · İstenen ton: ${tone}`,
    '',
    'Yazışma (eskiden yeniye):',
    history,
    extra,
    '',
    'Yukarıdaki SON müşteri mesajına yanıt taslakları üret.',
  ].join('\n');
}

/** Core — Context'siz, in-process çağrılabilir. */
export async function runReplyDraft(input: ReplyDraftRequest): Promise<RunReplyDraftResult> {
  if (!ANTHROPIC_API_KEY) {
    return { ok: false, status: 503, error: 'reply-draft unconfigured — ANTHROPIC_API_KEY env eksik' };
  }
  if (!input.thread_id && !input.message_id) {
    return { ok: false, status: 400, error: 'thread_id veya message_id gerekli' };
  }

  try {
    // 1. thread_id'yi çöz (message_id verildiyse ondan)
    let threadId = input.thread_id ?? null;
    if (!threadId && input.message_id) {
      const r = await sql`SELECT thread_id FROM email_messages WHERE id = ${input.message_id} LIMIT 1`;
      threadId = r[0]?.thread_id ?? null;
    }
    if (!threadId) {
      return { ok: false, status: 404, error: 'Thread bulunamadı' };
    }

    // 2. Thread + lead bağlamı
    const threadRows = await sql`
      SELECT et.subject, et.lead_id, l.company_name, l.primary_contact_name
      FROM email_threads et
      LEFT JOIN leads l ON l.id = et.lead_id
      WHERE et.id = ${threadId}
      LIMIT 1
    `;
    const thread = threadRows[0];
    if (!thread) {
      return { ok: false, status: 404, error: 'Thread bulunamadı' };
    }

    const msgRows = await sql`
      SELECT direction, from_name, body_text, body_html, created_at
      FROM email_messages
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC
      LIMIT 20
    `;
    const messages: ThreadMessageCtx[] = msgRows.map((m: any) => ({
      direction: m.direction,
      from_name: m.from_name,
      body: (m.body_text ?? stripHtml(m.body_html ?? '')).slice(0, 1500),
      created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at ?? ''),
    }));
    if (messages.length === 0 || !messages.some((m) => m.direction === 'inbound')) {
      return { ok: false, status: 400, error: 'Yanıtlanacak inbound mesaj yok' };
    }

    const userPrompt = buildDraftUserPrompt({
      company: thread.company_name,
      contact: thread.primary_contact_name,
      subject: thread.subject,
      messages,
      tone: input.tone,
      language: input.language,
      instructions: input.instructions,
    });

    // 3. Claude
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
    let drafts: string[];
    try {
      const response = await client.messages.create({
        model: DRAFT_MODEL,
        max_tokens: 1024,
        temperature: 0.6,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      });
      const block = response.content.find((b) => b.type === 'text');
      const text = block && 'text' in block ? block.text.trim() : '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      drafts = Array.isArray(parsed.drafts) ? parsed.drafts.filter((d: unknown) => typeof d === 'string' && d.trim()) : [];
    } catch (e: any) {
      console.error('[reply-draft] Claude error:', e?.message);
      return { ok: false, status: 500, error: 'Claude API hatası', detail: e?.message };
    }

    if (drafts.length === 0) {
      return { ok: false, status: 500, error: 'Taslak üretilemedi' };
    }
    return { ok: true, drafts, model: DRAFT_MODEL };
  } catch (e: any) {
    console.error('[reply-draft] unhandled:', e);
    return { ok: false, status: 500, error: 'internal_error', detail: e?.message ?? 'unknown' };
  }
}

/** HTTP handler — auth'lu (UI aksiyonu). */
export async function handleReplyDraft(c: Context): Promise<Response> {
  const auth = requireAuth(c);
  if (!auth) return c.json({ error: 'Auth gerek' }, 401);

  let body: ReplyDraftRequest;
  try {
    body = (await c.req.json()) as ReplyDraftRequest;
  } catch {
    return c.json({ error: 'invalid_json' }, 400);
  }
  const r = await runReplyDraft(body);
  if (!r.ok) {
    return c.json({ error: r.error, detail: r.detail }, r.status as 400 | 404 | 500 | 503);
  }
  return c.json({ success: true, drafts: r.drafts, model: r.model });
}
