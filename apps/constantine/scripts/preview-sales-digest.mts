// No-send önizleme: gerçek veriyle satış digest'ini compose eder, dosyaya yazar. GÖNDERMEZ.
import { previewSalesDigest } from '../src/cron-daily-digest.js';
import { writeFileSync } from 'node:fs';

const payload = await previewSalesDigest('Mert');
console.log('SUBJECT:', payload.subject);
console.log('----- TEXT -----');
console.log(payload.text);
console.log('----- /TEXT -----');
writeFileSync('/tmp/sales-digest-preview.html', payload.html, 'utf8');
console.log('HTML yazıldı: /tmp/sales-digest-preview.html (', payload.html.length, 'byte )');
process.exit(0);
