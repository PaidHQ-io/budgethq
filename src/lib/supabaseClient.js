/**
 * Frontend Supabase client — handles the login/signup UI and holds the user's session. Vite only
 * exposes env vars prefixed with VITE_ to browser code, so these are separate from the plain
 * SUPABASE_URL / SUPABASE_ANON_KEY the API routes read server-side (same values, different
 * prefix requirement) — both need to be set in Vercel's Environment Variables:
 *   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY=<the publishable/anon key from Supabase's API Keys page>
 * Neither is sensitive — the anon key is designed to be public in browser code — so the
 * "Sensitive" toggle in Vercel can stay off for these.
 */
import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Don't throw — better to render a visible error in the UI (AuthGate checks for this) than
  // to hard-crash the whole app bundle before React even mounts.
  console.error(
    "Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY. Set both in Vercel's Environment " +
      "Variables (and in a local .env file for `npm run dev`)."
  );
}

export const supabaseConfigured = Boolean(url && anonKey);
export const supabase = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder");
