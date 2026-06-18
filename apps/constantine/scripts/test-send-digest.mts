// Tek-seferlik TEST gönderimi — YALNIZCA Mert'e (ceketli@gmail.com). Recipient listesine dokunmaz.
// Günlük + haftalık digest'i gerçek veriyle compose edip [TEST] önekiyle gönderir.
import { previewSalesDigest } from '../src/cron-daily-digest.js';
import { previewWeeklyTrend } from '../src/cron-weekly-digest.js';
import { sendDigestViaResend } from '../src/digest-sender.js';

const TO = process.env.TEST_DIGEST_TO ?? 'ceketli@gmail.com';
const SENDER_EMAIL = process.env.DIGEST_SENDER_EMAIL ?? 'digest@send.constantineyachts.com';
const SENDER_NAME = process.env.DIGEST_SENDER_NAME ?? 'Constantine Sales';
const REPLY_TO = process.env.DIGEST_REPLY_TO ?? 'mert@constantineyachts.com';

async function send(kind: string, p: { subject: string; html: string; text: string }) {
  const res = await sendDigestViaResend({
    to: TO,
    subject: `[TEST] ${p.subject}`,
    html: p.html,
    text: p.text,
    senderEmail: SENDER_EMAIL,
    senderName: SENDER_NAME,
    replyTo: REPLY_TO,
    tags: [{ name: 'kind', value: `test-${kind}` }],
  });
  console.log(`${kind}: ok=${res.ok} messageId=${res.messageId ?? '-'} error=${res.error ?? '-'}`);
}

const daily = await previewSalesDigest('Mert');
await send('daily', daily);
await new Promise((r) => setTimeout(r, 400));
const weekly = await previewWeeklyTrend('Mert');
await send('weekly', weekly);

console.log(`\nİki test maili de ${TO} adresine gönderildi.`);
process.exit(0);
