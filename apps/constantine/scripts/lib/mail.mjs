/**
 * MAIL HIJYENI — TEK KAYNAK.
 * Kazinan bir dizginin gercekten posta adresi olup olmadigina burasi karar verir.
 * 26 Agu dersleri:
 *   · 'automatically' icindeki 'at' hecesi adres sanilmisti (196 "bulundu" -> gercek 79)
 *   · 'site@www.acropolhotel.com' — tablodaki "site: www..." satirindan uretilmis hayalet
 */
export const TLD_OK = new Set(['com','net','org','tr','info','biz','co','io','me','online','site',
  'travel','agency','tours','tour','web','gen','name','eu','de','uk','nl','fr','es','it','ru','az']);

const JUNK = ['example.','sentry.io','wixpress.com','wix.com','godaddy.','domain.com','email.com',
  'yourdomain','yoursite','test.com','sample.','w3.org','schema.org','wordpress.org','jquery',
  'bootstrap','fontawesome','googleapis','gstatic','cloudflare','.png','.jpg','.jpeg','.gif',
  '.webp','.svg','.css','.js','.woff','@2x','@media','@charset','sentry-','placeholder',
  'ornek@','mail@mail','name@','abc@','xxx@','user@','@example','@domain','@site','@localhost',
  '@email','@yourcompany','ad@soyad','no-reply@wix','@sentry','@wix'];

export function gecerliMail(raw) {
  if (!raw) return null;
  let e = String(raw).toLowerCase().trim().replace(/^mailto:/, '').split('?')[0]
          .replace(/^[.,;:'"(<[]+|[.,;:'")>\]]+$/g, '');
  if (!e.includes('@') || e.length > 80 || e.length < 6) return null;
  if (JUNK.some(j => e.includes(j))) return null;
  const yerel = e.slice(0, e.lastIndexOf('@'));
  const alan  = e.slice(e.lastIndexOf('@') + 1);
  if (!yerel || !alan.includes('.')) return null;
  if (alan.startsWith('.') || alan.endsWith('.') || alan.includes('..')) return null;
  // 'site@www.acropolhotel.com': posta alan adi 'www.' ile baslamaz — bu bir tablo/metin artigi
  if (alan.startsWith('www.')) return null;
  if (!TLD_OK.has(alan.split('.').pop())) return null;
  if (/^[0-9a-f]{16,}$/.test(yerel)) return null;   // hash
  if (/^[0-9]+$/.test(yerel)) return null;
  return e;
}
