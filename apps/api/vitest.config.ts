import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts', 'test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts', 'test/concurrency/**/*.test.ts', 'test/security/**/*.test.ts', 'test/properties/**/*.test.ts', 'test/fuzz/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/global-setup.ts'],
          setupFiles: ['test/setup.ts'],
          // integration tests share one database: run files sequentially, tests within a file sequentially
          fileParallelism: false,
          sequence: { concurrent: false },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
