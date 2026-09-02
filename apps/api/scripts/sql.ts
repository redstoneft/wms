// Ad-hoc SQL runner (no psql binary needed): npx tsx scripts/sql.ts "select 1" [--db wms_test]
import 'dotenv/config';
import pg from 'pg';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
let url = process.env.DATABASE_URL ?? 'postgresql://wms:change-me-in-production@localhost:5432/wms';
if (dbIdx >= 0) {
  const name = args[dbIdx + 1]!;
  url = url.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  args.splice(dbIdx, 2);
}
const sql = args.join(' ');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const statements = sql.split(/;\s*(?=\S)/).filter((s) => s.trim());
  for (const st of statements) {
    const r = await client.query(st);
    if (r.rows?.length) console.table(r.rows);
    else console.log(`${r.command} ${r.rowCount ?? ''}`.trim());
  }
} catch (e) {
  console.error('ERROR', (e as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
