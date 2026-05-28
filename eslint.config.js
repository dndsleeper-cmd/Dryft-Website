/**
 * ESLint flat config (ESLint 9+).
 *
 * Three zones with different environments:
 *   - api/**, scripts/** → Node.js (Vercel serverless + one-off CLI scripts), CommonJS
 *   - test/**            → Node.js, CommonJS, may use `global.fetch` overrides
 *   - assets/js/**       → Browser, no Node globals
 *
 * Style is lenient — we lint for real bugs (unused vars, undefined refs,
 * accidental globals), not formatting. Prettier handles formatting.
 */
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    // Files ESLint should never look at.
    ignores: [
      'node_modules/**',
      '.vercel/**',
      '.git/**',
      'package-lock.json',
      // Static HTML files have inline scripts ESLint can't parse cleanly
      // without an HTML plugin; not worth the dependency.
      '*.html',
    ],
  },
  js.configs.recommended,
  {
    // Server-side (Node) — Vercel serverless functions + shared lib + tests
    // + one-off maintenance scripts + config files at the repo root.
    files: ['api/**/*.js', 'test/**/*.js', 'scripts/**/*.js', '*.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-console': 'off', // console.error is the logging channel on Vercel
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'warn',
    },
  },
  {
    // Browser-side — runs in the user's browser, no Node globals.
    files: ['assets/js/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script', // main.js is a classic script, not a module
      globals: {
        ...globals.browser,
        grecaptcha: 'readonly', // Google reCAPTCHA v3 global, loaded async
      },
    },
    rules: {
      'no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'off', // main.js uses `var` in some IIFEs for older-browser compat
      'prefer-const': 'off',
    },
  },
];
