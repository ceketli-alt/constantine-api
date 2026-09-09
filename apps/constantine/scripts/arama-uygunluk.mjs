#!/usr/bin/env node
/** Telefon listesindeki siteli leadler kampanyaya GIREBILIR mi? (autofill'in kapilari) */
import postgres from 'postgres'; import fs from 'node:fs';
const env=Object.fromEntries(fs.readFileSync('/var/www/api/apps/constantine/.env','utf8').split('\n')
 .filter(l=>l.includes('=')&&!l.trim().startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i).trim(),l.slice(i+1).trim()];}));
const sql=postgres(env.DATABASE_URL);
const ids=fs.readFileSync('/root/acente-data-2026-08/ARAMA-SITELI-leadler.csv','utf8')
  .split(/\r?\n/).slice(1).filter(Boolean).map(l=>l.split(',')[0]).filter(x=>x.length===36);
const [r]=await sql`
  SELECT count(*)::int toplam,
    count(*) FILTER (WHERE status='new')::int yeni,
    count(*) FILTER (WHERE last_contacted_at IS NULL)::int hic_temas_yok,
    count(*) FILTER (WHERE 'seg-irrelevant'=ANY(tags))::int alakasiz,
    count(*) FILTER (WHERE 'mx-riskli'=ANY(tags))::int mx_riskli,
    count(*) FILTER (WHERE 'kimlik-dogrulanamadi'=ANY(tags))::int kimlik_yok,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM campaign_targets ct WHERE ct.lead_id=leads.id))::int zaten_kampanyada,
    count(*) FILTER (WHERE EXISTS (SELECT 1 FROM unsubscribes u WHERE u.channel='email'
       AND lower(u.identifier)=lower(leads.primary_contact_email)))::int cikmis
  FROM leads WHERE id = ANY(${ids}::uuid[])`;
console.log(r);
await sql.end();
