import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

// package.json has "type":"module", so this file is ESM — no __dirname global, has to be derived
// from import.meta.url instead (the standard ESM equivalent).
const __dirname = path.dirname(fileURLToPath(import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    // "@/" alias (2026-08-06, per Mo — Tailwind/shadcn/Tremor UI rebuild) — shadcn's own component
    // recipes and every doc example import via "@/components/ui/...", "@/lib/utils", so the new
    // src/components/ui/* primitives and src/lib/utils.js follow that same convention rather than
    // inventing a different relative-import style just for the new UI layer.
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    rollupOptions: {
      output: {
        // src/BudgetHQ.jsx (2026-07-25 split) statically imports lib/core.js, lib/reports.js,
        // components/shared.jsx, and hooks/useGoogleSheetConnect.js directly, while the four
        // lazy-loaded tab components (Dashboard/BudgetManager/PacingDashboard/AskAI) ALSO import
        // from those same files. Without a manualChunks rule, the bundler can't have an async
        // chunk import from the sync entry chunk, so it silently duplicates every shared module's
        // code into every chunk that needs it — each tab's chunk grows by ~100KB it doesn't own,
        // and the whole point of the split (ship less on first load) is lost. Forcing these into
        // one named "shared" chunk makes every chunk import from that single chunk instead.
        //
        // lib/askAI.js is deliberately its OWN separate chunk, not lumped into "shared" above —
        // the root entry never imports anything from it (only AskAI.jsx and PacingDashboard.jsx
        // do, both lazy), so merging it into "shared" would make its ~35KB an eager dependency of
        // every page load for no reason. Kept separate, it only loads when one of those two lazy
        // chunks actually loads.
        manualChunks(id) {
          if (id.includes('/src/lib/askAI.js')) {
            return 'ask-ai-engine';
          }
          if (
            id.includes('/src/lib/core.js') ||
            id.includes('/src/lib/reports.js') ||
            id.includes('/src/components/shared.jsx') ||
            id.includes('/src/hooks/useGoogleSheetConnect.js')
          ) {
            return 'shared';
          }
        },
      },
    },
  },
})
