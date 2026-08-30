import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'docs/.vitepress/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-control-regex': 'off',
    },
  },
  // Forbid direct `node:*` imports outside src/shims/ — all Node API access
  // must go through the shim layer so browser builds can swap the whole module.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/shims/**', 'src/context/async-context.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'node:fs/promises',
              message: 'Do not import node:* directly. Use src/shims/index.js instead.',
            },
            {
              name: 'node:path',
              message: 'Do not import node:* directly. Use src/shims/index.js instead.',
            },
            {
              name: 'node:os',
              message: 'Do not import node:* directly. Use src/shims/index.js instead.',
            },
            {
              name: 'node:child_process',
              message: 'Do not import node:* directly. Use src/shims/index.js instead.',
            },
            {
              name: 'node:async_hooks',
              message: 'Do not import node:* directly. Use src/shims/index.js instead.',
            },
          ],
        },
      ],
    },
  },
  // Integrates Prettier: disables conflicting ESLint formatting rules and runs
  // Prettier as the `prettier/prettier` rule, so `npm run lint` also enforces
  // formatting.
  prettierRecommended,
);
