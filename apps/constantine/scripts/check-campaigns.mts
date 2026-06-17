import 'dotenv/config';
import { sql } from '../src/db.js';

// Check campaign
const camp = await sql<any[]>`SELECT * FROM campaigns WHERE id = 'cc7f3817-8dba-4436-ad70-cc1cf83bc46a'`;
console.log('Campaign:', JSON.stringify(camp[0], null, 2));

// Check all tables
const tables = await sql<{tablename: string}[]>`
  SELECT tablename FROM pg_tables 
  WHERE schemaname = 'public' 
  ORDER BY tablename
`;
console.log('\nAll tables:', tables.map(t => t.tablename).join(', '));

// Campaigns schema
const cols = await sql<any[]>`
  SELECT column_name FROM information_schema.columns
  WHERE table_name = 'campaigns' ORDER BY ordinal_position
`;
console.log('\nCampaigns columns:', cols.map(c => c.column_name).join(', '));

await sql.end();
