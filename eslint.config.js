import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'dist-electron/**',
      'out/**',
      'node_modules/**',
      '.pnpm-store/**',
      'coverage/**',
      'prototype.html',
      'public/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
  },
  {
    // Renderer (browser) code
    files: ['src/**/*.ts', 'src/**/*.svelte'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // Injected by vite.config.ts `define` at build time.
        __APP_VERSION__: 'readonly',
        __APP_GIT_HASH__: 'readonly',
      },
    },
  },
  {
    // Main/preload/services (Node + Electron) code
    files: ['electron/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Repo-root config/scripts run under Node
    files: [
      '*.config.js',
      '*.config.ts',
      'scripts/**/*.mjs',
      'scripts/**/*.js',
      'eslint.config.js',
    ],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Playwright e2e drivers run under Node, but pass callbacks into
    // page.evaluate() that execute in the browser — those closures reference
    // browser globals (window) even though the file itself is a Node script.
    files: ['scripts/e2e/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    rules: {
      // The codebase leans on `any` in a handful of IPC/DTO boundary spots
      // (contract.ts, ipc glue) where precise typing wasn't worth the churn
      // when this was written. Downgraded to a warning rather than off so
      // new `any` usage is still visible in review, but existing code isn't
      // blocked. Revisit if the warning count grows unmanageable.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Svelte components commonly have unused exported `let` props (bound
      // from parent markup); the plugin's own rule handles that correctly,
      // this just keeps the TS rule from double-flagging component props.
      'no-unused-vars': 'off',
      // `try { fit.fit() } catch {}` (and similar) is a deliberate, pervasive
      // pattern here — best-effort calls (xterm fit/focus, git rev-parse
      // probes, etc.) where a failure is expected and safely ignorable.
      // Empty catch blocks specifically are allowed; other empty blocks still
      // error.
      'no-empty': ['error', { allowEmptyCatch: true }],
      // This rule does single-execution flow analysis, so it doesn't see a
      // value being read on a *future* invocation of the same closure — which
      // is exactly the "remember last value across calls" pattern used
      // throughout (Svelte `$:` guards like `lastTid`/`simStarted`, debounce
      // timer handles like `checkTimer`). Real single-execution dead stores
      // are rare enough here that we'd rather not lint-churn this pattern;
      // off rather than warn since it would otherwise flag on every such var.
      'no-useless-assignment': 'off',
    },
  },
  {
    // All `{@html}` usages in this codebase render `icons.*` — static SVG
    // string constants from src/lib/icons.ts, never user- or agent-controlled
    // data — so there's no actual XSS surface here. Off rather than warn: a
    // warning would fire on every one of the ~50 existing call sites for no
    // actionable reason. Any future `{@html}` on non-static content should be
    // caught in review.
    files: ['**/*.svelte'],
    rules: {
      'svelte/no-at-html-tags': 'off',
    },
  },
  prettier,
)
