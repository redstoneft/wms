// Flat config shared by all workspaces. Typecheck (tsc --strict) is the primary gate; ESLint adds hygiene rules.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/generated/**', '**/.pgdata/**', '**/playwright-report/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.browser, ...globals.es2022 } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
      'no-control-regex': 'off', // we intentionally match/strip control characters (ZPL, NUL sanitising)
    },
  },
  { files: ['**/*.test.ts', '**/test/**/*.ts', '**/e2e/**/*.ts'], rules: { '@typescript-eslint/no-unused-vars': 'off' } },
);
