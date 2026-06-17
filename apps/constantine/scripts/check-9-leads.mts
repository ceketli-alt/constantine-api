import 'dotenv/config';
import { sql } from '../src/db.js';

const targets = [
  'esat@carattours.com',
  'murat.kartal@presenttour.com.tr',
  'fatih@mygo.pro',
  'kezban@zesatravel.com',
  'info@ottoman-ht.com',
  'info@ayfaclinic.com',
  'info@mednificant.com',
  'info@anturizm.com',
  'info@tatilciniz.com.tr',
];

const rows = await sql`
  SELECT id, company_name, primary_contact_email, primary_contact_name, custom_fields, source, tags
  FROM leads
  WHERE lower(primary_contact_email) = ANY(${targets})
  ORDER BY primary_contact_email
`;
console.log(`Found ${rows.length} leads:\n`);
for (const r of rows) {
  console.log(`  ${r.primary_contact_email.padEnd(40)} | ${r.company_name.padEnd(50)} | ${r.primary_contact_name ?? '—'}`);
}
const med = rows.find(r => r.primary_contact_email === 'info@mednificant.com');
if (med) {
  console.log('\n--- Mednificant detail ---');
  console.log(JSON.stringify(med, null, 2));
}
await sql.end();
