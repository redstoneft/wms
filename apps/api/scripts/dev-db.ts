// Starts a local PostgreSQL 18 (embedded binaries) for development and tests
// when Docker is not available. Data lives in <repo>/wms/.pgdata.
// Usage: npx tsx scripts/dev-db.ts   (keeps running; Ctrl+C stops it)
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '../../../.pgdata');
const port = Number(process.env.PGPORT ?? 5432);
const user = process.env.POSTGRES_USER ?? 'wms';
const password = process.env.POSTGRES_PASSWORD ?? 'change-me-in-production';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user,
  password,
  port,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  postgresFlags: ['-c', 'max_connections=200', '-c', 'shared_buffers=256MB', '-c', 'log_min_duration_statement=1000'],
  onLog: (m) => process.stdout.write(String(m)),
  onError: (m) => process.stderr.write(String(m)),
});

async function main() {
  const fresh = !existsSync(path.join(dataDir, 'PG_VERSION'));
  if (fresh) {
    console.log(`[dev-db] initializing cluster at ${dataDir}`);
    await pg.initialise();
  }
  await pg.start();
  console.log(`[dev-db] postgres listening on 127.0.0.1:${port} (user=${user})`);
  for (const db of ['wms', 'wms_test']) {
    try {
      await pg.createDatabase(db);
      console.log(`[dev-db] created database ${db}`);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (!/already exists/i.test(msg)) throw e;
    }
  }
  console.log('[dev-db] ready. Press Ctrl+C to stop.');
  const stop = async () => {
    console.log('\n[dev-db] stopping...');
    await pg.stop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  // keep alive
  setInterval(() => {}, 1 << 30);
}

main().catch((e) => {
  console.error('[dev-db] failed:', e);
  process.exit(1);
});
