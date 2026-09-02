import 'dotenv/config';
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL_TEST ?? 'postgresql://wms:change-me-in-production@localhost:5432/wms_test';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? 'test-encryption-key-test-encryption-key-1234';
process.env.LOG_LEVEL = 'silent';
process.env.ALLOWED_ORIGINS = 'http://localhost:5173';
