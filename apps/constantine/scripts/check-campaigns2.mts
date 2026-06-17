import 'dotenv/config';
import { sql } from '../src/db.js';

// campaign_targets schema
const cols = await sql<any[]>`
  SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'campaign_targets' ORDER BY ordinal_position
`;
console.log('campaign_targets columns:', cols.map(c => c.column_name).join(', '));

// Sample targets for our campaign
const targets = await sql<any[]>`
  SELECT ct.*, l.primary_contact_email, l.company_name
  FROM campaign_targets ct
  LEFT JOIN leads l ON l.id = ct.lead_id
  WHERE ct.campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'
  ORDER BY ct.created_at
  LIMIT 5
`;
console.log('\nCampaign target count:');
const cnt = await sql<any[]>`SELECT count(*) FROM campaign_targets WHERE campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'`;
console.log('Count:', cnt[0]?.count);

console.log('\nSample targets:');
targets.forEach(t => {
  const { primary_contact_email, company_name, ...rest } = t;
  console.log(`\n${company_name} <${primary_contact_email}>`);
  console.log(JSON.stringify(rest, null, 2));
});

await sql.end();
