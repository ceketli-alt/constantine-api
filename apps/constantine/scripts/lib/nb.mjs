/**
 * NEVERBOUNCE — TEK KAYNAK.
 *
 * 29 Agu dersi: `campaign-autofill.mjs` enroll ettigi adresleri dogruluyordu ama
 * ELLE enroll eden scriptler (1b-yeniden-baslat, enroll-verified-pool, arafta-...)
 * bu adimi ATLIYORDU. `tavbilet@tav.aero` o bosluktan gecti ve bounce etti.
 * Yeni kural: campaign_targets'a INSERT eden HER script bu modulu kullanir.
 *
 * Politika (29 Agu, Mert onayli):
 *   invalid / disposable / unknown -> ALINMAZ
 *   valid / catchall               -> alinir
 * Catch-all'da kutunun var oldugu gondermeden anlasilamaz; kuyrugun ~%40'i boyle.
 */
export const RISKLI = new Set(['invalid', 'disposable', 'unknown']);

/** Tek adres sorgular. Sonuc: 'valid'|'catchall'|'unknown'|'invalid'|'disposable'|'hata' */
export async function nbTek(mail, key) {
  try {
    const u = new URL('https://api.neverbounce.com/v4/single/check');
    u.searchParams.set('key', key);
    u.searchParams.set('email', mail);
    const d = await (await fetch(u)).json();
    return d.status === 'success' ? (d.result || 'hata') : 'hata';
  } catch { return 'hata'; }
}

/**
 * Adres listesini dogrular. Donen: { sonuclar: Map<mail,sonuc>, riskli: string[], sayim: {} }
 * 'hata' RISKLI sayilmaz — NeverBounce'a ulasilamamasi adresin kotu oldugu anlamina gelmez.
 */
export async function nbDogrula(mailler, key, { gecikmeMs = 200, ilerleme = null } = {}) {
  const sonuclar = new Map(); const sayim = {}; const riskli = [];
  const tekil = [...new Set(mailler.map(m => (m || '').toLowerCase()).filter(Boolean))];
  for (let i = 0; i < tekil.length; i++) {
    const r = await nbTek(tekil[i], key);
    sonuclar.set(tekil[i], r);
    sayim[r] = (sayim[r] || 0) + 1;
    if (RISKLI.has(r)) riskli.push(tekil[i]);
    if (ilerleme && (i + 1) % 25 === 0) ilerleme(i + 1, tekil.length, riskli.length);
    if (gecikmeMs) await new Promise(res => setTimeout(res, gecikmeMs));
  }
  return { sonuclar, riskli, sayim };
}
