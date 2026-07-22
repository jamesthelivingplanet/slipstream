import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import svelte from 'eslint-plugin-svelte'
import globals from 'globals'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      // Agent worktrees (full repo checkouts under .claude/worktrees/) and
      // other Claude Code scratch files — not source we lint.
      '.claude/**',
      'dist/**',
      'dist-electron/**',
      'out/**',
      'node_modules/**',
      '.pnpm-store/**',
      'coverage/**',
      'prototype.html',
      'public/**',
      // Capacitor-generated native Android project (Java/Gradle/XML plus
      // Gradle-intermediate JS bundles like native-bridge.js) — not
      // hand-written code, not ours to lint.
      'mobile/android/**',
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
      // The codebase is `any`-free; treat any new usage as an error so it
      // must be justified (or typed properly) rather than slipping in. Tests
      // that assert on untyped JSON-RPC/DTO boundaries narrow with explicit
      // cast types sourced from the module under test (see appMcp.test.ts).
      '@typescript-eslint/no-explicit-any': 'error',
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
