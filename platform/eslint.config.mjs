// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    // .next/types is Next.js build output — generated route type stubs that use
    // `Function` and `{}` by design. Linting generated code reports the
    // generator's style, not ours.
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.js',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly', __dirname: 'readonly' },
    },
    rules: {
      // Nest's DI relies on decorator metadata and empty constructors.
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-empty-function': ['error', { allow: ['constructors'] }],
      // Deliberate unused values are marked with a leading underscore.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // `any` is a smell worth seeing, not a blocker mid-refactor.
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },
  {
    // Seeds and tests legitimately print and reach for loose types.
    files: ['**/*.spec.ts', 'apps/api/test/**/*.ts', 'apps/api/prisma/seed.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
