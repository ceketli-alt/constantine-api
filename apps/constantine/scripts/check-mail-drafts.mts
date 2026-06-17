import 'dotenv/config';
import { sql } from '../src/db.js';

// Check email_threads schema
const tCols = await sql<{column_name: string; data_type: string}[]>`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_name = 'email_threads'
  ORDER BY ordinal_position
`;
console.log('=== email_threads columns ===');
tCols.forEach(c => console.log(c.column_name.padEnd(30), c.data_type));

// Count campaign messages
const cnt = await sql<any[]>`
  SELECT count(*) 
  FROM email_messages 
  WHERE campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'
`;
console.log('\nCampaign message count:', cnt[0]?.count);

// Sample with correct columns
const msgs = await sql<any[]>`
  SELECT em.id, em.subject, em.to_email, em.from_email,
         LEFT(em.body_html, 150) AS body_preview,
         em.thread_id
  FROM email_messages em
  WHERE em.campaign_id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'
  ORDER BY em.created_at
  LIMIT 4
`;
console.log('\n=== Sample campaign drafts ===');
msgs.forEach(m => {
  console.log('\nid:', m.id);
  console.log('subject:', m.subject);
  console.log('to_email:', m.to_email);
  console.log('from_email:', m.from_email);
  console.log('thread_id:', m.thread_id);
  console.log('body_html preview:', m.body_preview);
});

// Check thread → lead connection
if (msgs[0]?.thread_id) {
  const thread = await sql<any[]>`
    SELECT id, lead_id, subject FROM email_threads WHERE id = ${msgs[0].thread_id}
  `;
  console.log('\nThread → lead_id:', thread[0]?.lead_id, '| subject:', thread[0]?.subject);
}

await sql.end();
