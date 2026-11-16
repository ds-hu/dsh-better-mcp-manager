import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';

/**
 * Flat ESLint configuration.
 *
 * Three environments live in this package:
 *  - Node (Host half, CLI, all tests) — module syntax, Node globals;
 *  - the browser bundle `lib/client.js` — a hand-written classic script that
 *    only registers a lazy factory with `window.__ModuleLoader__`, so it must
 *    not be parsed as a module and runs against browser globals;
 *  - the E2E harness, which runs in Node but embeds page callbacks that the
 *    browser evaluates (`document`, `window`, …).
 */
export default defineConfig([
  {
    ignores: [
      'node_modules/**',
      'coverage/**',
      '*.tgz',
      'test/.tmp/**',
      'test/e2e/artifacts/**',
      'e2e-artifacts/**',
      'docs/screenshots/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['eslint.config.js', 'lib/**/*.js', 'bin/**/*.mjs', 'test/**/*.{js,mjs}'],
    ignores: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.nodeBuiltin,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
      // An explicit empty catch is how the cleanup paths say "nothing useful
      // can be done here"; empty blocks anywhere else still fail.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // The browser half: a classic script, never a module, evaluated by the
    // shell and by test/client-smoke.mjs.
    files: ['lib/client.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: globals.browser,
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  {
    // Playwright evaluates the page callbacks in the browser.
    files: ['test/e2e/**/*.{js,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.nodeBuiltin, ...globals.browser },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
]);
