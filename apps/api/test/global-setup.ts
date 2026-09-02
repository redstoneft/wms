// Runs once before the integration project: points at the TEST database,
// applies migrations, and seeds base data. Never touches the dev database.
import 'dotenv/config';
import { execSync } from 'node:child_process';

export default async function globalSetup() {
  const testUrl = process.env.DATABASE_URL_TEST ?? 'postgresql://wms:change-me-in-production@localhost:5432/wms_test';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testUrl;
  process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? 'test-encryption-key-test-encryption-key-1234';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'silent';
  const env = { ...process.env, DATABASE_URL: testUrl, NODE_ENV: 'test' };
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env });
  execSync('npx tsx prisma/seed.ts', { stdio: 'pipe', env: { ...env, SEED_ADMIN_PASSWORD: 'Admin-Test-Password-1!' } });
}
