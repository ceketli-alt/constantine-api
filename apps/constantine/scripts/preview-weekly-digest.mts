// No-send önizleme: haftalık trend digest'ini gerçek veriyle compose eder, dosyaya yazar. GÖNDERMEZ.
import { previewWeeklyTrend } from '../src/cron-weekly-digest.js';
import { writeFileSync } from 'node:fs';

const payload = await previewWeeklyTrend('Mert');
console.log('SUBJECT:', payload.subject);
console.log('----- TEXT -----');
console.log(payload.text);
console.log('----- /TEXT -----');
writeFileSync('/tmp/weekly-digest-preview.html', payload.html, 'utf8');
console.log('HTML yazıldı: /tmp/weekly-digest-preview.html (', payload.html.length, 'byte )');
process.exit(0);
