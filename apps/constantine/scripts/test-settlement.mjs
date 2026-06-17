#!/usr/bin/env node
/**
 * E2E test: /functions/v1/settlement-snapshot + /functions/v1/settlement-transfer
 *
 * Sade model: Caner = sıradan ortak, payer/payee transfer.
 *
 * Çalıştır:
 *   cd /var/www/api/apps/constantine
 *   node --env-file=.env scripts/test-settlement.mjs [start YYYY-MM-DD] [end YYYY-MM-DD]
 */
import postgres from 'postgres';
import { SignJWT } from 'jose';

const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4001';

if (!JWT_SECRET) { console.error('JWT_SECRET eksik'); process.exit(1); }

const today = new Date();
const defaultStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-01`;
const lastDay = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0)).getUTCDate();
const defaultEnd = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

const START = process.argv[2] || defaultStart;
const END = process.argv[3] || defaultEnd;

const sql = postgres(DATABASE_URL, { max: 2 });

const [mert] = await sql`
  SELECT id, email, role FROM profiles WHERE id = '07fb3763-e2ce-4fde-ae29-398b586cdd6f'
`;
if (!mert) { console.error('Mert profile bulunamadı'); process.exit(1); }

const secret = new TextEncoder().encode(JWT_SECRET);
const token = await new SignJWT({ sub: mert.id, email: mert.email, role: mert.role, iss: 'constantine-api' })
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(secret);

console.log(`[setup] ${mert.email} as ${mert.role}, token 1h`);
console.log(`[scope] ${START} → ${END}`);
console.log('');

const baseHeaders = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const snapRes = await fetch(`${API_URL}/functions/v1/settlement-snapshot`, {
  method: 'POST',
  headers: baseHeaders,
  body: JSON.stringify({ start: START, end: END }),
});
const snap = await snapRes.json();
if (!snapRes.ok) {
  console.error('SNAPSHOT FAIL', snapRes.status, snap);
  process.exit(1);
}

console.log('=== ÖZET ===');
console.log(`Brüt gelir TRY: ${snap.summary.gross_revenue_try.toLocaleString('tr-TR')}`);
console.log(`Gider TRY:      ${snap.summary.expense_try.toLocaleString('tr-TR')}`);
console.log(`Net kâr TRY:    ${snap.summary.net_profit_try.toLocaleString('tr-TR')}`);
console.log(`Acente hacim:   ${snap.summary.agency_volume_try.toLocaleString('tr-TR')}`);
console.log(`Paid bookings:  ${snap.summary.paid_booking_count}/${snap.summary.total_booking_count}`);
console.log(`Onaylı gider:   ${snap.summary.expense_count}`);
console.log('');

console.log('=== KÂR DAĞILIMI ===');
for (const ps of snap.profit_share) {
  console.log(`  ${ps.name.padEnd(14)} %${ps.pct.toString().padStart(2)} → ${ps.amount_try.toLocaleString('tr-TR').padStart(15)} TL`);
}
console.log('');

console.log('=== ORTAKLAR ===');
for (const p of snap.partners) {
  console.log(`  ${p.name}:`);
  console.log(`         kâr payı:         ${p.profit_share_try.toLocaleString('tr-TR').padStart(15)} TL`);
  console.log(`         cebine giren:     ${p.collected_to_pocket_try.toLocaleString('tr-TR').padStart(15)} TL`);
  console.log(`         cebinden harcadı: ${p.expense_paid_from_pocket_try.toLocaleString('tr-TR').padStart(15)} TL`);
  console.log(`         ortaklardan aldı: ${p.received_from_partners_try.toLocaleString('tr-TR').padStart(15)} TL`);
  console.log(`         ortaklara verdi:  ${p.paid_to_partners_try.toLocaleString('tr-TR').padStart(15)} TL`);
  const label = p.balance_try > 0 ? 'ALACAK' : p.balance_try < 0 ? 'BORÇ' : 'NÖTR';
  console.log(`         BAKİYE:           ${p.balance_try.toLocaleString('tr-TR').padStart(15)} TL  (${label})`);
}
console.log('');

if (snap.suggested_transfers.length > 0) {
  console.log('=== KİM KİME VERECEK (greedy çözüm) ===');
  for (const t of snap.suggested_transfers) {
    console.log(`  ${t.from_name} → ${t.to_name}: ${t.amount_try.toLocaleString('tr-TR')} TL`);
  }
  console.log('');
}

console.log(`=== TAHSİL EDİLMEYEN (${snap.unpaid_bookings.length} tur) ===`);
console.log('  (Bizim pay - alınan kapora payı = kalan)');
for (const u of snap.unpaid_bookings.slice(0, 12)) {
  console.log(`  ${u.date} | ${(u.guest_name || '').padEnd(28).slice(0,28)} | bizim ${u.our_share_try.toLocaleString('tr-TR').padStart(9)} | kapora ${u.deposit_our_share_try.toLocaleString('tr-TR').padStart(9)} | KALAN ${u.remaining_try.toLocaleString('tr-TR').padStart(9)} | ${u.payment_status}`);
}
if (snap.unpaid_bookings.length > 12) console.log(`  ...ve ${snap.unpaid_bookings.length - 12} daha`);
const totalUnpaidPay = snap.unpaid_bookings.reduce((s, u) => s + u.our_share_try, 0);
const totalUnpaidRemaining = snap.unpaid_bookings.reduce((s, u) => s + u.remaining_try, 0);
console.log(`  TOPLAM BİZİM PAY: ${totalUnpaidPay.toLocaleString('tr-TR')} TL`);
console.log(`  TOPLAM KALAN:    ${totalUnpaidRemaining.toLocaleString('tr-TR')} TL`);
console.log('');

console.log('=== TRANSFER ENDPOINT TEST (payer → payee, sonra sil) ===');
const transferRes = await fetch(`${API_URL}/functions/v1/settlement-transfer`, {
  method: 'POST',
  headers: baseHeaders,
  body: JSON.stringify({
    payer_id: '910ef3f9-c2e2-458f-a9b6-640191e599c8', // Hasan ödüyor
    payee_id: '07fb3763-e2ce-4fde-ae29-398b586cdd6f', // Mert alıyor
    amount_try: 1,
    occurred_at: START,
    note: 'TEST (silinecek)',
  }),
});
const transferRet = await transferRes.json();
if (!transferRes.ok) {
  console.error('TRANSFER FAIL', transferRes.status, transferRet);
  await sql.end();
  process.exit(1);
}
console.log(`  insert OK: ${transferRet.transaction.id} (Hasan → Mert: 1 TL)`);

const delRes = await fetch(`${API_URL}/functions/v1/settlement-transfer/${transferRet.transaction.id}`, {
  method: 'DELETE',
  headers: baseHeaders,
});
const delRet = await delRes.json();
console.log(`  delete: ${delRes.status} ${JSON.stringify(delRet)}`);

await sql.end();
console.log('\n✅ Tüm endpoint testleri başarılı');
