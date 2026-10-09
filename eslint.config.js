import { builtinModules } from 'node:module';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Every Node built-in, bare and node:-prefixed. CI's grep of dist/edge.js only catches the
// node: form, so the source rule bans both.
const nodeBuiltins = builtinModules.flatMap((name) =>
  name.startsWith('node:') ? [name] : [name, `node:${name}`],
);

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: { parserOptions: { projectService: true } },
    // An interface may declare a parameter an implementation has no use for.
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
  },
  {
    files: ['spike/**/*.mjs', '*.config.js'],
    languageOptions: { globals: globals.node },
    // `const { dropped, ...rest } = obj` is how the spike omits a field before printing.
    rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true }] },
  },
  {
    // Invariant 8: the core and the Edge entry run where Node built-ins do not exist.
    files: ['src/core/**', 'src/transports/**', 'src/edge.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltins.map((name) => ({
            name,
            message:
              'The core and Edge entry must not import Node built-ins (CLAUDE.md invariant 8).',
          })),
        },
      ],
    },
  },
  {
    // Invariant 7: server-only. No browser globals anywhere in the package source.
    files: ['src/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        ...['window', 'document', 'navigator'].map((name) => ({
          name,
          message: 'This package is server-only (CLAUDE.md invariant 7).',
        })),
      ],
    },
  },
  prettier,
);
