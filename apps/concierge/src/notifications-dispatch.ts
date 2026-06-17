// Concierge Connect — notifications dispatcher (ported from the Supabase Edge
// Function to Hono/Node).
//
// Drains the `notifications` queue (populated by DB triggers on
// vendor/reseller/booking/product/settlement transitions), renders subject +
// body from inline TR templates, sends via Resend (resend-send.ts), and marks
// each row sent/failed/pending. Idempotent per row; safe to call repeatedly.
//
// The queue is admin-only (RLS + postgres-only GRANTs); the backend reaches it
// through the SECURITY DEFINER helpers in migration 0002_notifications_dispatch
// (notifications_claim_batch / _mark / _pending_count).
//
// Runner is gated by NOTIFICATIONS_DISPATCH_ENABLED=true. POST
// /functions/v1/notifications-dispatch (platform_admin) triggers a drain on
// demand and can retry specific rows via { ids: [...] }.
import type { Context } from 'hono'
import { sql } from './db.js'
import { sendEmail } from './resend-send.js'
import { requireAuth } from './middleware.js'

const RESEND_API_KEY = process.env.RESEND_API_KEY ?? ''
const ADMIN_URL = process.env.SITE_URL_ADMIN ?? 'https://cc-admin.constantineyachts.com'

const MAX_ATTEMPTS = 3
const BATCH_SIZE = 50
const SEND_GAP_MS = 220 // Resend 5 req/s rate limit
const PLATFORM = 'Concierge Connect'
const PRIMARY_COLOR = '#1f5be0'

interface NotificationRow {
  id: string
  event: string
  recipient_email: string
  recipient_name: string | null
  recipient_role: string
  payload: Record<string, unknown>
  attempts: number
  related_entity_kind: string | null
  related_entity_id: string | null
}

interface Rendered {
  subject: string
  text: string
  html: string
}

// ---------- template helpers ----------

function esc(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function fmtMoney(amount: unknown, currency: unknown): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return ''
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : `${currency} `
  return `${sym}${n.toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtDate(iso: unknown): string {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return String(iso ?? '')
  const months = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran',
                  'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık']
  const [y, m, d] = iso.slice(0, 10).split('-')
  if (!y || !m || !d) return iso
  return `${parseInt(d)} ${months[parseInt(m) - 1]} ${y}`
}

function kvTable(rows: Array<[string, string]>): string {
  return `<table style="margin-top:12px;width:100%;border-collapse:collapse;font-size:14px;">
    ${rows.map(([k, v]) => `
      <tr>
        <td style="padding:6px 0;color:#64748b;width:140px;vertical-align:top;">${esc(k)}</td>
        <td style="padding:6px 0;color:#0f172a;vertical-align:top;">${v}</td>
      </tr>`).join('')}
  </table>`
}

function wrap(title: string, body: string): string {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#0f172a;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f1f5f9;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
        <tr><td style="padding:24px 32px;border-bottom:1px solid #e2e8f0;">
          <div style="color:${PRIMARY_COLOR};letter-spacing:0.08em;text-transform:uppercase;font-size:11px;font-weight:700;">${PLATFORM}</div>
          <h1 style="margin:6px 0 0;font-size:20px;color:#0f172a;font-weight:600;">${esc(title)}</h1>
        </td></tr>
        <tr><td style="padding:24px 32px;color:#334155;font-size:14px;line-height:1.6;">
          ${body}
        </td></tr>
        <tr><td style="padding:16px 32px;border-top:1px solid #e2e8f0;color:#94a3b8;font-size:12px;line-height:1.5;">
          Bu e-postayı ${PLATFORM} platformunun bir parçası olduğunuz için aldınız.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`
}

// ---------- templates ----------

function render(n: NotificationRow): Rendered {
  const p = n.payload as Record<string, any>
  const name = n.recipient_name ?? ''

  switch (n.event) {
    case 'vendor.submitted': {
      const subject = `Yeni tedarikçi başvurusu: ${p.display_name}`
      const text = [
        `Yeni bir tedarikçi platforma başvurdu.`,
        ``,
        `Firma: ${p.display_name}`,
        `Kategori: ${p.category ?? ''}`,
        `İletişim: ${p.contact_name ?? ''} <${p.contact_email ?? ''}>`,
        ``,
        `Admin panelinde Tedarikçiler sayfasından inceleyebilirsiniz.`,
      ].join('\n')
      const html = wrap('Yeni tedarikçi başvurusu', `
        <p>Yeni bir tedarikçi platforma katılmak için başvurdu.</p>
        ${kvTable([
          ['Firma', esc(p.display_name)],
          ['Kategori', esc(p.category)],
          ['İletişim', `${esc(p.contact_name ?? '')} &lt;${esc(p.contact_email)}&gt;`],
        ])}
        <p style="margin-top:18px;">Admin panelinde <strong>Tedarikçiler</strong> sayfasından onay/red işlemini yapabilirsiniz.</p>
      `)
      return { subject, text, html }
    }

    case 'vendor.approved': {
      const subject = `${PLATFORM} hesabınız onaylandı`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.display_name} tedarikçi hesabınız onaylandı. Artık ürünlerinizi ekleyebilir ve müsaitliğinizi yönetebilirsiniz.`,
        ``,
        `Hoş geldiniz!`,
      ].join('\n')
      const html = wrap('Hesabınız onaylandı', `
        <p>Merhaba ${esc(name)},</p>
        <p><strong>${esc(p.display_name)}</strong> tedarikçi hesabınız onaylandı.</p>
        <p>Artık panele giriş yapıp:</p>
        <ul style="padding-left:20px;color:#334155;">
          <li>Ürünlerinizi ekleyebilir,</li>
          <li>Fiyat kategorilerini belirleyebilir,</li>
          <li>Müsaitlik takviminizi yönetebilirsiniz.</li>
        </ul>
        <p>Hoş geldiniz!</p>
      `)
      return { subject, text, html }
    }

    case 'vendor.rejected': {
      const subject = `${PLATFORM} başvurunuz hakkında`
      const reason = p.rejection_reason ?? '—'
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.display_name} tedarikçi başvurunuz şu aşamada onaylanmadı.`,
        ``,
        `Açıklama: ${reason}`,
        ``,
        `Detay için bizimle iletişime geçebilirsiniz.`,
      ].join('\n')
      const html = wrap('Başvurunuz hakkında', `
        <p>Merhaba ${esc(name)},</p>
        <p><strong>${esc(p.display_name)}</strong> tedarikçi başvurunuz şu aşamada onaylanmadı.</p>
        ${kvTable([['Açıklama', esc(reason)]])}
        <p style="margin-top:14px;">Detay için bizimle iletişime geçebilirsiniz.</p>
      `)
      return { subject, text, html }
    }

    case 'reseller.submitted': {
      const subject = `Yeni otel/acente başvurusu: ${p.display_name}`
      const text = [
        `Yeni bir ${p.kind === 'agency' ? 'acente' : 'otel'} platforma başvurdu.`,
        ``,
        `İsim: ${p.display_name}`,
        `Şehir: ${p.city ?? ''}`,
        `İletişim: ${p.contact_name ?? ''} <${p.contact_email ?? ''}>`,
      ].join('\n')
      const html = wrap('Yeni otel/acente başvurusu', `
        <p>Yeni bir ${esc(p.kind === 'agency' ? 'acente' : 'otel')} platforma katılmak için başvurdu.</p>
        ${kvTable([
          ['İsim', esc(p.display_name)],
          ['Şehir', esc(p.city)],
          ['İletişim', `${esc(p.contact_name ?? '')} &lt;${esc(p.contact_email)}&gt;`],
        ])}
        <p style="margin-top:18px;">Admin panelinde <strong>Oteller &amp; Acenteler</strong> sayfasından inceleyebilirsiniz.</p>
      `)
      return { subject, text, html }
    }

    case 'reseller.approved': {
      const subject = `${PLATFORM} hesabınız onaylandı`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.display_name} hesabınız onaylandı. Artık paneline giriş yapıp white-label vitrininizi yönetebilirsiniz.`,
        ``,
        `White-label vitrin slug'ınız: ${p.slug ?? '(henüz atanmadı)'}`,
      ].join('\n')
      const html = wrap('Hesabınız onaylandı', `
        <p>Merhaba ${esc(name)},</p>
        <p><strong>${esc(p.display_name)}</strong> hesabınız onaylandı.</p>
        <p>Artık paneline giriş yapıp:</p>
        <ul style="padding-left:20px;color:#334155;">
          <li>Branding (logo, renk) ayarlarınızı yapabilir,</li>
          <li>White-label vitrininizi görebilir,</li>
          <li>Rezervasyonlarınızı takip edebilirsiniz.</li>
        </ul>
        ${p.slug ? `<p style="margin-top:8px;">Vitrin slug'ınız: <code>${esc(p.slug)}</code></p>` : ''}
      `)
      return { subject, text, html }
    }

    case 'reseller.rejected': {
      const subject = `${PLATFORM} başvurunuz hakkında`
      const reason = p.rejection_reason ?? '—'
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.display_name} başvurunuz şu aşamada onaylanmadı.`,
        ``,
        `Açıklama: ${reason}`,
      ].join('\n')
      const html = wrap('Başvurunuz hakkında', `
        <p>Merhaba ${esc(name)},</p>
        <p><strong>${esc(p.display_name)}</strong> başvurunuz şu aşamada onaylanmadı.</p>
        ${kvTable([['Açıklama', esc(reason)]])}
      `)
      return { subject, text, html }
    }

    case 'booking.created': {
      const isGuest = n.recipient_role === 'guest'
      const title = isGuest ? 'Rezervasyonunuz alındı' : 'Yeni rezervasyon'
      const subject = `${title} — ${p.reference}`
      const text = [
        isGuest
          ? `Merhaba ${p.guest_name},\n\nRezervasyonunuz alındı. Onaylandığında size tekrar haber vereceğiz.`
          : `Yeni bir rezervasyon oluşturuldu.`,
        ``,
        `Referans: ${p.reference}`,
        `Ürün: ${p.product_title}`,
        `Tarih: ${fmtDate(p.booking_date)}`,
        `Kişi sayısı: ${p.pax_total}`,
        `Tutar: ${fmtMoney(p.total, p.currency)}`,
        p.reseller_name ? `Otel/Acente: ${p.reseller_name}` : '',
      ].filter(Boolean).join('\n')
      const html = wrap(title, `
        ${isGuest
          ? `<p>Merhaba <strong>${esc(p.guest_name)}</strong>,</p>
             <p>Rezervasyonunuz alındı. Tedarikçi onayladığında size tekrar haber vereceğiz.</p>`
          : `<p>Yeni bir rezervasyon oluşturuldu.</p>`}
        ${kvTable([
          ['Referans', `<code>${esc(p.reference)}</code>`],
          ['Ürün', esc(p.product_title)],
          ['Tarih', esc(fmtDate(p.booking_date))],
          ['Kişi sayısı', String(p.pax_total)],
          ['Tutar', esc(fmtMoney(p.total, p.currency))],
          ...(p.reseller_name && !isGuest ? [['Otel/Acente', esc(p.reseller_name)] as [string, string]] : []),
          ...(p.guest_name && !isGuest ? [['Misafir', esc(p.guest_name)] as [string, string]] : []),
        ])}
      `)
      return { subject, text, html }
    }

    case 'booking.confirmed': {
      const isGuest = n.recipient_role === 'guest'
      const title = isGuest ? 'Rezervasyonunuz onaylandı' : 'Rezervasyon onaylandı'
      const subject = `${title} — ${p.reference}`
      const text = [
        isGuest
          ? `Merhaba ${p.guest_name},\n\nRezervasyonunuz tedarikçi tarafından onaylandı.`
          : `Bir rezervasyon onaylandı.`,
        ``,
        `Referans: ${p.reference}`,
        `Ürün: ${p.product_title}`,
        `Tarih: ${fmtDate(p.booking_date)}`,
        `Kişi sayısı: ${p.pax_total}`,
        `Tutar: ${fmtMoney(p.total, p.currency)}`,
      ].join('\n')
      const html = wrap(title, `
        ${isGuest
          ? `<p>Merhaba <strong>${esc(p.guest_name)}</strong>,</p>
             <p>Rezervasyonunuz tedarikçi tarafından <strong style="color:#15803d;">onaylandı</strong>. Aşağıdaki referansı yanınızda bulundurun.</p>`
          : `<p>Bir rezervasyon onaylandı.</p>`}
        ${kvTable([
          ['Referans', `<code>${esc(p.reference)}</code>`],
          ['Ürün', esc(p.product_title)],
          ['Tarih', esc(fmtDate(p.booking_date))],
          ['Kişi sayısı', String(p.pax_total)],
          ['Tutar', esc(fmtMoney(p.total, p.currency))],
        ])}
      `)
      return { subject, text, html }
    }

    case 'booking.cancelled': {
      const isGuest = n.recipient_role === 'guest'
      const title = isGuest ? 'Rezervasyonunuz iptal edildi' : 'Rezervasyon iptal edildi'
      const subject = `${title} — ${p.reference}`
      const text = [
        isGuest ? `Merhaba ${p.guest_name},\n\nMaalesef rezervasyonunuz iptal edildi.` : `Bir rezervasyon iptal edildi.`,
        ``,
        `Referans: ${p.reference}`,
        `Ürün: ${p.product_title}`,
        `Tarih: ${fmtDate(p.booking_date)}`,
      ].join('\n')
      const html = wrap(title, `
        ${isGuest
          ? `<p>Merhaba <strong>${esc(p.guest_name)}</strong>,</p>
             <p>Maalesef rezervasyonunuz <strong style="color:#b91c1c;">iptal edildi</strong>. Sorularınız için bizimle iletişime geçebilirsiniz.</p>`
          : `<p>Bir rezervasyon iptal edildi.</p>`}
        ${kvTable([
          ['Referans', `<code>${esc(p.reference)}</code>`],
          ['Ürün', esc(p.product_title)],
          ['Tarih', esc(fmtDate(p.booking_date))],
        ])}
      `)
      return { subject, text, html }
    }

    case 'product.submitted': {
      const subject = `Yeni ürün incelemesi: ${p.title}`
      const text = `Yeni bir ürün yayınlanmak üzere incelemeye gönderildi:\n\nÜrün: ${p.title}\nTip: ${p.type}\n`
      const html = wrap('Yeni ürün incelemesi', `
        <p>Yeni bir ürün yayınlanmak üzere incelemeye gönderildi.</p>
        ${kvTable([['Ürün', esc(p.title)], ['Tip', esc(p.type)]])}
        <p style="margin-top:18px;">Admin panelinde <strong>Katalog</strong> sayfasından inceleyebilirsiniz.</p>
      `)
      return { subject, text, html }
    }

    case 'product.approved': {
      const subject = `Ürününüz yayında: ${p.title}`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.title} adlı ürününüz yayına alındı ve artık otel & acente vitrinlerinde görünüyor.`,
      ].join('\n')
      const html = wrap('Ürününüz yayında', `
        <p>Merhaba ${esc(name)},</p>
        <p><strong>${esc(p.title)}</strong> adlı ürününüz yayına alındı ve artık otel &amp; acente vitrinlerinde görünüyor.</p>
      `)
      return { subject, text, html }
    }

    case 'settlement.created': {
      const subject = `Yeni hakediş hazırlandı: ${p.reference}`
      const direction = p.direction === 'payable_to_vendor' ? 'size yapılacak ödeme'
                      : p.direction === 'payable_to_reseller' ? 'size yapılacak komisyon ödemesi'
                      : p.direction === 'receivable_from_reseller' ? 'sizden alınacak tahsilat'
                      : 'hareket'
      const text = [
        `Merhaba ${name},`,
        ``,
        `Yeni bir hakediş statementı hazırlandı: ${p.reference}`,
        ``,
        `Tür: ${direction}`,
        `Dönem: ${p.period_start} → ${p.period_end}`,
        `Toplam: ${fmtMoney(p.amount, p.currency)}`,
        `Hareket sayısı: ${p.movement_count}`,
        ``,
        `Detay için panelinizde Hakedişler sayfasını ziyaret edebilirsiniz.`,
      ].join('\n')
      const html = wrap('Yeni hakediş', `
        <p>Merhaba ${esc(name)},</p>
        <p>Yeni bir hakediş statementı hazırlandı.</p>
        ${kvTable([
          ['Referans', `<code>${esc(p.reference)}</code>`],
          ['Tür', esc(direction)],
          ['Dönem', `${esc(p.period_start)} → ${esc(p.period_end)}`],
          ['Toplam', esc(fmtMoney(p.amount, p.currency))],
          ['Hareket', String(p.movement_count)],
        ])}
        <p style="margin-top:18px;">Detay için panelinizde <strong>Hakedişler</strong> sayfasını ziyaret edebilirsiniz.</p>
      `)
      return { subject, text, html }
    }

    case 'settlement.sent': {
      const subject = `Hakediş gönderildi: ${p.reference}`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.reference} numaralı hakedişiniz gönderildi.`,
        ``,
        `Toplam: ${fmtMoney(p.amount, p.currency)}`,
        `Dönem: ${p.period_start} → ${p.period_end}`,
      ].join('\n')
      const html = wrap('Hakediş gönderildi', `
        <p>Merhaba ${esc(name)},</p>
        <p><code>${esc(p.reference)}</code> numaralı hakedişiniz gönderildi.</p>
        ${kvTable([
          ['Toplam', esc(fmtMoney(p.amount, p.currency))],
          ['Dönem', `${esc(p.period_start)} → ${esc(p.period_end)}`],
        ])}
      `)
      return { subject, text, html }
    }

    case 'settlement.paid': {
      const subject = `Hakediş ödendi: ${p.reference}`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.reference} numaralı hakediş ödenmiştir.`,
        ``,
        `Toplam: ${fmtMoney(p.amount, p.currency)}`,
        ``,
        `Teşekkür ederiz.`,
      ].join('\n')
      const html = wrap('Hakediş ödendi', `
        <p>Merhaba ${esc(name)},</p>
        <p><code>${esc(p.reference)}</code> numaralı hakediş <strong style="color:#15803d;">ödenmiştir</strong>.</p>
        ${kvTable([['Toplam', esc(fmtMoney(p.amount, p.currency))]])}
        <p style="margin-top:14px;">Teşekkür ederiz.</p>
      `)
      return { subject, text, html }
    }

    case 'invitation.sent': {
      const inviteUrl = `${ADMIN_URL}/login?invite=${encodeURIComponent(p.token)}`
      const displayName = (p.display_name as string | null) || (n.recipient_name ?? 'Otelimiz')
      const subject = `${PLATFORM}'a davet edildiniz`
      const personalNote = p.message ? `\n\nDavet eden mesajı:\n"${p.message}"` : ''
      const text = [
        `Merhaba ${displayName},`,
        ``,
        `Concierge Connect'e davet edildiniz. Aşağıdaki linki kullanarak hesabınızı oluşturun ve marketplace'i misafirlerinize sunmaya başlayın:`,
        ``,
        inviteUrl,
        personalNote,
        ``,
        `Bu davet linki ${new Date(p.expires_at as string).toLocaleDateString('tr-TR')} tarihine kadar geçerlidir.`,
      ].join('\n')
      const noteHtml = p.message
        ? `<blockquote style="margin:14px 0;padding:10px 14px;border-left:3px solid #2563eb;background:#eff6ff;color:#1e3a8a;font-size:14px;">${esc(String(p.message))}</blockquote>`
        : ''
      const html = wrap(`${PLATFORM}'a davet`, `
        <p>Merhaba ${esc(displayName)},</p>
        <p>Concierge Connect'e davet edildiniz. Aşağıdaki butonu kullanarak hesabınızı oluşturun ve marketplace'i misafirlerinize sunmaya başlayın.</p>
        <p style="text-align:center;margin:24px 0;">
          <a href="${esc(inviteUrl)}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:white;text-decoration:none;border-radius:8px;font-weight:600;">Hesap Oluştur</a>
        </p>
        ${noteHtml}
        <p style="color:#64748b;font-size:13px;">Bu davet linki ${esc(new Date(p.expires_at as string).toLocaleDateString('tr-TR'))} tarihine kadar geçerlidir.</p>
      `)
      return { subject, text, html }
    }

    case 'invitation.accepted': {
      const subject = `Davetiniz kabul edildi: ${p.email}`
      const text = `Davet ettiğiniz ${p.email} hesabını oluşturdu ve onay sürecine girdi.`
      const html = wrap('Davet kabul edildi', `
        <p>Davet ettiğiniz <strong>${esc(p.email as string)}</strong> hesabını oluşturdu.</p>
        <p style="margin-top:14px;color:#64748b;">Admin panelinde <strong>Oteller</strong> kuyruğunda onay bekliyor.</p>
      `)
      return { subject, text, html }
    }

    case 'payment.recorded': {
      const remaining = Number(p.remaining ?? 0)
      const fullyPaid = remaining <= 0
      const methodLabel = (() => {
        switch (p.method) {
          case 'bank_transfer': return 'banka havalesi'
          case 'cash': return 'nakit'
          case 'card': return 'kart'
          default: return 'diğer'
        }
      })()
      const subject = fullyPaid
        ? `Hakediş tamamen ödendi: ${p.reference}`
        : `Hakedişe ödeme yapıldı: ${p.reference}`
      const text = [
        `Merhaba ${name},`,
        ``,
        `${p.reference} numaralı hakedişe ${fmtMoney(Number(p.amount), String(p.currency))} (${methodLabel}) tutarında ödeme kaydedildi.`,
        ``,
        fullyPaid
          ? 'Hakediş tamamen ödendi. Teşekkür ederiz.'
          : `Kalan tutar: ${fmtMoney(remaining, String(p.currency))}`,
      ].join('\n')
      const html = wrap(fullyPaid ? 'Hakediş tamamen ödendi' : 'Yeni ödeme kaydedildi', `
        <p>Merhaba ${esc(name)},</p>
        <p><code>${esc(String(p.reference))}</code> numaralı hakedişe ödeme kaydedildi.</p>
        ${kvTable([
          ['Tutar', esc(fmtMoney(Number(p.amount), String(p.currency)))],
          ['Yöntem', esc(methodLabel)],
          ['Tarih', esc(String(p.paid_at))],
          [fullyPaid ? 'Durum' : 'Kalan', fullyPaid ? '<strong style="color:#15803d;">TAMAMEN ÖDENDİ</strong>' : esc(fmtMoney(remaining, String(p.currency)))],
        ])}
      `)
      return { subject, text, html }
    }

    default: {
      // Unknown event — generic fallback so a row never crashes the dispatcher.
      const subject = `${PLATFORM} bildirim: ${n.event}`
      const text = `Yeni bildirim:\n\n${JSON.stringify(p, null, 2)}`
      const html = wrap('Bildirim', `<pre style="background:#f1f5f9;padding:12px;border-radius:8px;font-size:12px;overflow:auto;">${esc(JSON.stringify(p, null, 2))}</pre>`)
      return { subject, text, html }
    }
  }
}

// ---------- dispatch ----------

export interface DispatchSummary {
  processed: number
  sent: number
  failed: number
  pending_remaining: number
  resend_configured: boolean
}

// In-process mutex so the 60s timer and a manual POST never double-send a row.
let draining = false

/**
 * Drain a batch of pending notifications (or specific `ids` for retry).
 * Reaches the admin-only queue via the SECURITY DEFINER helpers from
 * migration 0002 (so concierge_user needs no table grant / admin JWT).
 */
export async function drainNotifications(ids?: string[]): Promise<DispatchSummary> {
  const summary: DispatchSummary = {
    processed: 0, sent: 0, failed: 0, pending_remaining: 0,
    resend_configured: !!RESEND_API_KEY,
  }
  if (!summary.resend_configured) return summary
  if (draining) return summary
  draining = true
  try {
    const rows = await sql<NotificationRow[]>`
      SELECT id, event, recipient_email, recipient_name, recipient_role,
             payload, attempts, related_entity_kind, related_entity_id
      FROM notifications_claim_batch(${BATCH_SIZE}, ${MAX_ATTEMPTS}, ${ids ?? null})
    `
    for (const row of rows) {
      summary.processed += 1
      let rendered: Rendered
      try {
        rendered = render(row)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await sql`SELECT notifications_mark(${row.id}, 'failed'::notification_status, NULL, ${'render: ' + msg})`
        summary.failed += 1
        continue
      }
      const to = row.recipient_name ? `${row.recipient_name} <${row.recipient_email}>` : row.recipient_email
      const result = await sendEmail({ to, subject: rendered.subject, html: rendered.html, text: rendered.text })
      if (result.status === 'queued') {
        await sql`SELECT notifications_mark(${row.id}, 'sent'::notification_status, ${result.id || null}, NULL)`
        summary.sent += 1
      } else {
        const isFinal = row.attempts + 1 >= MAX_ATTEMPTS
        await sql`SELECT notifications_mark(${row.id}, ${isFinal ? 'failed' : 'pending'}::notification_status, NULL, ${result.error ?? 'unknown error'})`
        summary.failed += 1
      }
      if (SEND_GAP_MS > 0) await new Promise((r) => setTimeout(r, SEND_GAP_MS))
    }
    const cnt = await sql<{ c: number }[]>`SELECT notifications_pending_count(${MAX_ATTEMPTS}) AS c`
    summary.pending_remaining = cnt[0]?.c ?? 0
    return summary
  } finally {
    draining = false
  }
}

// POST /functions/v1/notifications-dispatch — platform_admin manual trigger / retry.
export async function handleNotificationsDispatch(c: Context): Promise<Response> {
  const auth = requireAuth(c)
  if (!auth) return c.json({ error: 'auth required' }, 401)
  if (auth.role !== 'platform_admin') return c.json({ error: 'platform_admin required' }, 403)
  if (!RESEND_API_KEY) return c.json({ error: 'RESEND_API_KEY not configured', resend_configured: false }, 503)
  let ids: string[] | undefined
  try {
    const body = await c.req.json() as { ids?: string[] }
    if (Array.isArray(body?.ids) && body.ids.length > 0) ids = body.ids
  } catch { /* no body — drain pending */ }
  const summary = await drainNotifications(ids)
  return c.json(summary)
}

// In-process runner — gated by NOTIFICATIONS_DISPATCH_ENABLED=true.
let runnerStarted = false
export function startNotificationsRunner(): void {
  if (runnerStarted) return
  if (process.env.NOTIFICATIONS_DISPATCH_ENABLED !== 'true') {
    console.log('[notifications] runner disabled (set NOTIFICATIONS_DISPATCH_ENABLED=true to enable)')
    return
  }
  if (!RESEND_API_KEY) {
    console.warn('[notifications] RESEND_API_KEY missing — runner not started')
    return
  }
  runnerStarted = true
  const tick = async () => {
    try {
      const s = await drainNotifications()
      if (s.processed > 0) {
        console.log(`[notifications] drained processed=${s.processed} sent=${s.sent} failed=${s.failed} remaining=${s.pending_remaining}`)
      }
    } catch (e) {
      console.error('[notifications] drain error:', e instanceof Error ? e.message : e)
    }
  }
  setInterval(tick, 60_000)
  setTimeout(tick, 5_000) // first pass shortly after boot
  console.log('[notifications] runner started (60s interval)')
}
