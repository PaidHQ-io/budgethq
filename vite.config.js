import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Temporary: sourcemaps let a minified production stack trace ("Cannot access 'gr' before
  // initialization") map back to real file/line/variable names in devtools, instead of guessing
  // from 2-letter minified identifiers. Safe to remove once the bug that prompted this is found.
  build: { sourcemap: true },
})
