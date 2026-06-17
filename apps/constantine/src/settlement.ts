/**
 * /functions/v1/settlement-snapshot — Hesaplaşma snapshot endpoint
 * /functions/v1/settlement-transfer — Ortak ↔ Ortak para hareketi insert
 *
 * CONSTANTINE teknesi için. Diğer tekneler dahil değil.
 *
 * Tahakkuk modeli: Gelir/gider, turun yapıldığı periyot üzerinden hesaplanır
 * (bookings.date / expenses.date). Ödeme/gider yapılma tarihi farklı periyotta
 * olsa bile.
 *
 * Sade ortaklık modeli (2026-05-31 revize):
 *   - Mert %40, Hasan %30, Caner %30
 *   - Şirket kasası kavramı YOK. Caner sıradan ortak.
 *   - Her ortak için: kişisel cebine giren (collector_id), cebinden harcadığı
 *     (expenses.created_by), kâr payı, alacak/borç bakiyesi.
 *   - Transferler: bir ortaktan diğerine doğrudan (payer → payee).
 *
 * Bizim Payımız hesabı:
 *   our_share_try → bookings tablosundaki bizim payımız (acente komisyonu hariç)
 *   "Kalan bizim pay" = our_share_try − (kapora cebimize girdiyse) deposit_try×ratio
 */
import type { Context } from 'hono';
import { sql } from './db.js';
import { requireAuth } from './middleware.js';

const CONSTANTINE_BOAT_ID = '222a10f8-6d66-41ec-9162-198d26d84cde';
const MERT_ID    = '07fb3763-e2ce-4fde-ae29-398b586cdd6f';
const HASAN_ID   = '910ef3f9-c2e2-458f-a9b6-640191e599c8';
const CANER_ID   = 'da35626e-4fb6-4515-81be-777e2ea66b49';

interface PartnerDef {
  id: string;
  name: string;
  pct: number;
}

const SETTLEMENT_PARTNERS: PartnerDef[] = [
  { id: MERT_ID,  name: 'Mert Ödemiş', pct: 40 },
  { id: HASAN_ID, name: 'Hasan Erol',  pct: 30 },
  { id: CANER_ID, name: 'Caner Çetin', pct: 30 },
];
const PARTNER_ID_SET = new Set([MERT_ID, HASAN_ID, CANER_ID]);

/**
 * 3 ortak dışında biri (Ali, Can, Umut, Serhat, Aziz, Mahir vb.) tarafından
 * yapılmış collector veya gider girişlerini hesaplaşmada Caner'e remap eder.
 * Diğer sekmelerde (Expenses, Bookings) gerçek created_by/collector_id korunur.
 * Null değer (kim olduğu belirsiz) olduğu gibi null kalır.
 */
function normalizeToPartner(id: string | null | undefined): string | null {
  if (!id) return null;
  return PARTNER_ID_SET.has(id) ? id : CANER_ID;
}

function asIso(v: any): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const y = v.getUTCFullYear();
    const m = String(v.getUTCMonth() + 1).padStart(2, '0');
    const d = String(v.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

async function requireSettlementAccess(c: Context): Promise<{ userId: string } | { error: string; status: number }> {
  const auth = requireAuth(c);
  if (!auth?.userId) return { error: 'Auth required', status: 401 };
  const rows = await sql`
    SELECT settlement_view_access FROM profiles WHERE id = ${auth.userId}
  `;
  if (!rows[0]?.settlement_view_access) {
    return { error: 'Hesaplaşma sayfasına erişim yetkin yok', status: 403 };
  }
  return { userId: auth.userId };
}

export async function handleSettlementSnapshot(c: Context) {
  try {
    const access = await requireSettlementAccess(c);
    if ('error' in access) return c.json({ error: access.error }, access.status as 401 | 403);

    const body = await c.req.json().catch(() => ({}));
    let start = String(body.start || '');
    let end = String(body.end || '');
    const YMD = /^\d{4}-\d{2}-\d{2}$/;
    // Savunma: boş/geçersiz tarih gelirse 400 ile patlatma — içinde bulunulan aya düş.
    // (Frontend "Özel" preset'te boş kutu gönderebiliyordu → sayfa "Edge Function non-2xx" veriyordu.)
    if (!YMD.test(start) || !YMD.test(end)) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const first = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-01`;
      const lastDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
      const last = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(lastDay)}`;
      start = first;
      end = last;
    }

    // 1. Periyot bookings (CONSTANTINE, tur tarihi aralıkta, iptal hariç)
    const bookings = await sql<any[]>`
      SELECT id, date, guest_name, contact, adult, child, infant,
             total_price, total_price_try, our_share, our_share_try,
             currency, exchange_rate,
             payment_status, payment_method, payment_date, payment_collector_id,
             deposit_amount, deposit_method, deposit_date, deposit_collector_id,
             remaining_due_date, remaining_method, remaining_collector,
             status, notes
      FROM bookings
      WHERE boat_id = ${CONSTANTINE_BOAT_ID}
        AND date BETWEEN ${start} AND ${end}
        AND status != 'cancelled'
      ORDER BY date ASC
    `;

    // 2. Periyot expenses (CONSTANTINE, onaylı)
    const expenses = await sql<any[]>`
      SELECT id, date, category, amount, amount_try, currency, description,
             status, created_by, approved_by, recurring_template_id
      FROM expenses
      WHERE boat_id = ${CONSTANTINE_BOAT_ID}
        AND date BETWEEN ${start} AND ${end}
        AND status = 'approved'
      ORDER BY date ASC
    `;

    // 3. Periyot içi partner transferleri (ortak ↔ ortak)
    const transactions = await sql<any[]>`
      SELECT pt.id, pt.payer_id, pt.payee_id, pt.amount_try,
             pt.occurred_at, pt.note, pt.created_by, pt.created_at,
             payer.full_name AS payer_name,
             payee.full_name AS payee_name
      FROM partner_transactions pt
      LEFT JOIN profiles payer ON payer.id = pt.payer_id
      LEFT JOIN profiles payee ON payee.id = pt.payee_id
      WHERE pt.occurred_at BETWEEN ${start} AND ${end}
      ORDER BY pt.occurred_at ASC
    `;

    // ─────── HESAPLAMA ───────

    // Acente-collected hariç bizim tahsil edebileceğimiz turlar
    const ourBookings = bookings.filter((b) => b.payment_method !== 'agency_collected');
    const paidBookings = ourBookings.filter((b) => b.payment_status === 'paid');

    const gross_revenue_try = paidBookings.reduce(
      (s, b) => s + Number(b.our_share_try || 0),
      0,
    );
    const expense_try = expenses.reduce(
      (s, e) => s + Number(e.amount_try || 0),
      0,
    );
    const net_profit_try = gross_revenue_try - expense_try;

    // Referans bilgi: acente kanalıyla giden hacim
    const agency_volume_try = bookings
      .filter((b) => b.payment_method === 'agency_collected')
      .reduce((s, b) => s + Number(b.total_price_try || 0), 0);

    // Kâr payı dağılımı
    const profit_share = SETTLEMENT_PARTNERS.map((p) => ({
      partner_id: p.id,
      name: p.name,
      pct: p.pct,
      amount_try: round2(net_profit_try * (p.pct / 100)),
    }));

    // Cebine giren — sadece PAID bookings üzerinden
    type CollectorPart = { collector_id: string; amount: number; kind: string; booking_id: string };
    function collectorParts(b: any): CollectorPart[] {
      const total = Number(b.total_price_try || 0);
      const ourShare = Number(b.our_share_try || 0);
      const ratio = total > 0 ? ourShare / total : 1;  // total=0 → tüm tahsilat bizim payımız
      const exch = Number(b.exchange_rate || 1);
      const depositOrig = Number(b.deposit_amount || 0);
      const depositTry = depositOrig * exch;

      const parts: CollectorPart[] = [];

      // Kapora parçası (acente kapora değilse)
      if (
        depositTry > 0 &&
        b.deposit_collector_id &&
        b.deposit_method !== 'agency_collected'
      ) {
        const remapped = normalizeToPartner(b.deposit_collector_id);
        if (remapped) {
          parts.push({
            collector_id: remapped,
            amount: depositTry * ratio,
            kind: 'deposit',
            booking_id: b.id,
          });
        }
      }

      // Kalan / tam ödeme parçası
      const remainingOurShare = Math.max(0, ourShare - depositTry * ratio);
      if (remainingOurShare > 0) {
        const collector = b.remaining_collector || b.payment_collector_id;
        const method = b.remaining_method || b.payment_method;
        if (collector && method !== 'agency_collected') {
          const remapped = normalizeToPartner(collector);
          if (remapped) {
            parts.push({
              collector_id: remapped,
              amount: remainingOurShare,
              kind: 'remaining',
              booking_id: b.id,
            });
          }
        }
      }

      return parts;
    }

    const allCollectorParts = paidBookings.flatMap(collectorParts);

    // Partner detayları — herkes aynı format, kasa kavramı yok
    const partners = SETTLEMENT_PARTNERS.map((p) => {
      const partnerShare =
        profit_share.find((ps) => ps.partner_id === p.id)?.amount_try ?? 0;

      const collected = allCollectorParts
        .filter((c) => c.collector_id === p.id)
        .reduce((s, c) => s + c.amount, 0);
      // expense: 3 ortak dışındaki kullanıcıların kayıtları Caner'e remap edilir
      const expense_paid = expenses
        .filter((e) => normalizeToPartner(e.created_by) === p.id)
        .reduce((s, e) => s + Number(e.amount_try || 0), 0);

      // Bu ortağın aldığı transferler (payee) ve verdiği transferler (payer)
      const received_from_partners = transactions
        .filter((t) => t.payee_id === p.id)
        .reduce((s, t) => s + Number(t.amount_try || 0), 0);
      const paid_to_partners = transactions
        .filter((t) => t.payer_id === p.id)
        .reduce((s, t) => s + Number(t.amount_try || 0), 0);

      const earned = partnerShare + expense_paid;
      // balance > 0 → ALACAK (bu ortağa ödeme yapılmalı)
      // balance < 0 → BORÇ (bu ortak başkasına ödeme yapmalı)
      const balance =
        earned
        - collected
        - received_from_partners
        + paid_to_partners;

      return {
        partner_id: p.id,
        name: p.name,
        pct: p.pct,
        profit_share_try: round2(partnerShare),
        expense_paid_from_pocket_try: round2(expense_paid),
        collected_to_pocket_try: round2(collected),
        earned_try: round2(earned),
        received_from_partners_try: round2(received_from_partners),
        paid_to_partners_try: round2(paid_to_partners),
        balance_try: round2(balance),
        // 3-ortak-dışı (kaptan/crew) tahsilat ve giderler bu ortağa remap edilir (normalizeToPartner → CANER_ID).
        // Frontend "Cebine giren"/"Cebinden harcadığı" linkinde remap grubunu Collections/Expenses'e taşımak için.
        absorbs_unassigned: p.id === CANER_ID,
      };
    });

    // Önerilen transferler — greedy: borçluyu alacaklıya öde
    type SuggestedTransfer = {
      from: string;
      from_name: string;
      to: string;
      to_name: string;
      amount_try: number;
    };
    const suggested_transfers: SuggestedTransfer[] = (() => {
      const creditors = partners
        .filter((p) => p.balance_try > 0.01)
        .map((p) => ({ id: p.partner_id, name: p.name, remaining: p.balance_try }))
        .sort((a, b) => b.remaining - a.remaining);
      const debtors = partners
        .filter((p) => p.balance_try < -0.01)
        .map((p) => ({ id: p.partner_id, name: p.name, remaining: -p.balance_try }))
        .sort((a, b) => b.remaining - a.remaining);

      const out: SuggestedTransfer[] = [];
      let i = 0, j = 0;
      while (i < debtors.length && j < creditors.length) {
        // Guard üstte (i/j < length) garanti veriyor; TS noUncheckedIndexedAccess yine de
        // T|undefined dönüyor — non-null assertion ile narrow.
        const d = debtors[i]!;
        const c = creditors[j]!;
        const amt = Math.min(d.remaining, c.remaining);
        if (amt > 0.01) {
          out.push({
            from: d.id, from_name: d.name,
            to: c.id, to_name: c.name,
            amount_try: round2(amt),
          });
        }
        d.remaining -= amt;
        c.remaining -= amt;
        if (d.remaining < 0.01) i++;
        if (c.remaining < 0.01) j++;
      }
      return out;
    })();

    // Tahsil edilmeyenler — "kalan = bizim pay − kapora bizim payı"
    const unpaid_bookings = ourBookings
      .filter((b) => b.payment_status !== 'paid')
      .map((b) => {
        const total = Number(b.total_price_try || 0);
        const ourShare = Number(b.our_share_try || 0);
        const exch = Number(b.exchange_rate || 1);
        const depositOrig = Number(b.deposit_amount || 0);
        const depositTry = depositOrig * exch;
        // Kapora bizim payımıza ne kadar düştü
        const ratio = total > 0 ? ourShare / total : 1;
        const depositOurShareTry = b.deposit_method === 'agency_collected' ? 0 : depositTry * ratio;
        const remainingOurShareTry = Math.max(0, ourShare - depositOurShareTry);
        return {
          id: b.id,
          date: asIso(b.date),
          guest_name: b.guest_name,
          contact: b.contact,
          pax: Number(b.adult || 0) + Number(b.child || 0) + Number(b.infant || 0),
          currency: b.currency,
          total_original: Number(b.total_price || 0),
          total_try: round2(total),
          our_share_try: round2(ourShare),
          deposit_amount_original: depositOrig,
          deposit_try: round2(depositTry),
          deposit_our_share_try: round2(depositOurShareTry),
          remaining_try: round2(remainingOurShareTry),
          payment_status: b.payment_status,
          payment_method: b.payment_method,
          deposit_method: b.deposit_method,
          remaining_due_date: asIso(b.remaining_due_date),
          remaining_method: b.remaining_method,
          notes: b.notes,
        };
      });

    return c.json({
      period: { start, end, boat: 'CONSTANTINE' },
      summary: {
        gross_revenue_try: round2(gross_revenue_try),
        expense_try: round2(expense_try),
        net_profit_try: round2(net_profit_try),
        agency_volume_try: round2(agency_volume_try),
        paid_booking_count: paidBookings.length,
        unpaid_booking_count: unpaid_bookings.length,
        total_booking_count: bookings.length,
        expense_count: expenses.length,
      },
      profit_share,
      partners,
      suggested_transfers,
      unpaid_bookings,
      transactions: transactions.map((t) => ({
        id: t.id,
        payer_id: t.payer_id,
        payer_name: t.payer_name,
        payee_id: t.payee_id,
        payee_name: t.payee_name,
        amount_try: Number(t.amount_try),
        occurred_at: asIso(t.occurred_at),
        note: t.note,
      })),
    });
  } catch (e: any) {
    console.error('settlement-snapshot error:', e);
    return c.json({ error: e?.message || 'snapshot error' }, 500);
  }
}

export async function handleSettlementTransfer(c: Context) {
  try {
    const access = await requireSettlementAccess(c);
    if ('error' in access) return c.json({ error: access.error }, access.status as 401 | 403);

    const body = await c.req.json();
    const payer_id = String(body.payer_id || '');
    const payee_id = String(body.payee_id || '');
    const amount_try = Number(body.amount_try || 0);
    const occurred_at = String(body.occurred_at || new Date().toISOString().slice(0, 10));
    const note = body.note ? String(body.note) : null;

    if (!payer_id || !/^[0-9a-f-]{36}$/i.test(payer_id)) {
      return c.json({ error: 'payer_id geçersiz' }, 400);
    }
    if (!payee_id || !/^[0-9a-f-]{36}$/i.test(payee_id)) {
      return c.json({ error: 'payee_id geçersiz' }, 400);
    }
    if (payer_id === payee_id) {
      return c.json({ error: 'payer_id ve payee_id aynı olamaz' }, 400);
    }
    if (!(amount_try > 0)) {
      return c.json({ error: 'amount_try > 0 olmalı' }, 400);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(occurred_at)) {
      return c.json({ error: 'occurred_at YYYY-MM-DD bekleniyor' }, 400);
    }

    const [tx] = await sql<any[]>`
      INSERT INTO partner_transactions
        (payer_id, payee_id, amount_try, occurred_at, note, created_by)
      VALUES
        (${payer_id}, ${payee_id}, ${amount_try}, ${occurred_at}, ${note}, ${access.userId})
      RETURNING id, payer_id, payee_id, amount_try, occurred_at, note, created_by, created_at
    `;

    return c.json({
      ok: true,
      transaction: {
        ...tx,
        amount_try: Number(tx.amount_try),
        occurred_at: asIso(tx.occurred_at),
      },
    });
  } catch (e: any) {
    console.error('settlement-transfer error:', e);
    return c.json({ error: e?.message || 'transfer error' }, 500);
  }
}

export async function handleSettlementTransferDelete(c: Context) {
  try {
    const access = await requireSettlementAccess(c);
    if ('error' in access) return c.json({ error: access.error }, access.status as 401 | 403);

    const id = c.req.param('id') || '';
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return c.json({ error: 'id geçersiz' }, 400);
    }
    const result = await sql`DELETE FROM partner_transactions WHERE id = ${id} RETURNING id`;
    if (!result.length) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true, deleted_id: id });
  } catch (e: any) {
    console.error('settlement-transfer-delete error:', e);
    return c.json({ error: e?.message || 'delete error' }, 500);
  }
}
