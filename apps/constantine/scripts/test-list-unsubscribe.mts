// Tek-seferlik DOĞRULAMA — List-Unsubscribe header'ının gerçekten telde olduğunu kanıtlar.
// Production'ın AYNI header-builder'ını (unsubscribe.ts) + AYNI outreach Resend provider'ını kullanır.
// sendEmailCore'u çağırmaz → prod veriyi (campaign_targets/email_messages) KİRLETMEZ.
// Dummy lead-id (zero-uuid) → unsubscribe linki tıklanırsa zararsız (eşleşen lead yok).
// Hedef: SADECE ceketli@gmail.com (Mert'in kendi adresi).
import 'dotenv/config';
import { buildListUnsubscribeHeaders, buildUnsubscribeUrl } from '../src/unsubscribe.js';
import { mailProviderForKind } from '../src/mail/index.js';

const TO = process.env.TEST_DIGEST_TO ?? 'ceketli@gmail.com';
const DUMMY_LEAD = '00000000-0000-0000-0000-000000000000';
const headers = buildListUnsubscribeHeaders(DUMMY_LEAD, 'email');
const unsubUrl = buildUnsubscribeUrl(DUMMY_LEAD, 'email');

const html = `
<p>Bu, <b>List-Unsubscribe</b> başlığının gerçekten gönderildiğini doğrulamak için atılan bir test mailidir.</p>
<p>Gmail'de gönderen adının yanında "Abonelikten çık" butonu görmelisin, ve "Orijinali göster"de
<code>List-Unsubscribe</code> + <code>List-Unsubscribe-Post</code> satırları olmalı.</p>
<hr style="margin-top:32px;border:none;border-top:1px solid #e5e5e5"/>
<p style="font-size:11px;color:#aaa;">Constantine Yachts · Beşiktaş, İstanbul ·
Aboneliğinizi <a href="${unsubUrl}">buradan</a> sonlandırabilirsiniz.</p>`;
const text = `List-Unsubscribe doğrulama testi.\n\n-- \nConstantine Yachts\nBeşiktaş, İstanbul\nAbonelikten çıkmak için: ${unsubUrl}`;

const provider = mailProviderForKind('outreach');
console.log('Gönderilen headers:', JSON.stringify(headers, null, 2));
console.log('Outreach provider:', provider.name);

const res = await provider.send({
  from: 'Constantine Yachts <mert@constantineyachts.online>',
  to: [TO],
  replyTo: 'mert@constantineyachts.com',
  subject: '[TEST] List-Unsubscribe header doğrulama',
  html,
  text,
  tags: [{ name: 'kind', value: 'test-list-unsub' }],
  headers,
});

console.log(`\nSonuç: ok=${res.ok} messageId=${res.messageId ?? '-'} error=${(res as any).error ?? '-'}`);
console.log(`Hedef: ${TO}`);
process.exit(res.ok ? 0 : 1);
