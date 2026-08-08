import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      // eslint-plugin-react-hooks v6's "recommended" set bundles the React Compiler rules
      // (react-hooks/preserve-manual-memoization, react-hooks/purity, etc.). Those only make sense
      // when the compiler actually runs the build and re-adds memoization/enforces purity — this
      // project uses plain @vitejs/plugin-react with NO react-compiler babel plugin (see
      // vite.config.js), so they fire as false positives on intentional, correct manual useMemo/
      // useCallback and on timestamps read inside event handlers. Turned off so real lint (unused
      // vars, exhaustive-deps, etc.) isn't buried under compiler noise. Re-enable these if/when the
      // React Compiler is added to the build. (2026-08-07)
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/purity': 'off',
    },
  },
])
