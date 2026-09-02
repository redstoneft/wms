import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { closeDb } from './db.js';
import { startBackgroundJobs } from './jobs.js';

async function main() {
  const cfg = loadConfig();
  const app = await buildApp({ config: cfg });
  const stopJobs = startBackgroundJobs(app.log);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    stopJobs();
    try {
      await app.close();
      await closeDb();
      process.exit(0);
    } catch (e) {
      app.log.error(e, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    app.log.error({ reason }, 'unhandledRejection');
  });

  await app.listen({ port: cfg.API_PORT, host: cfg.API_HOST });
  app.log.info(`WMS API listening on http://${cfg.API_HOST}:${cfg.API_PORT} (${cfg.NODE_ENV})`);
}

main().catch((e) => {
  console.error('fatal', e);
  process.exit(1);
});
