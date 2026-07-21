/**
 * Frontend Supabase client factory — handles the login/signup UI and holds the user's session(s).
 * Vite only exposes env vars prefixed with VITE_ to browser code, so these are separate from the
 * plain SUPABASE_URL / SUPABASE_ANON_KEY the API routes read server-side (same values, different
 * prefix requirement) — both need to be set in Vercel's Environment Variables:
 *   VITE_SUPABASE_URL=https://<project-ref>.supabase.co
 *   VITE_SUPABASE_ANON_KEY=<the publishable/anon key from Supabase's API Keys page>
 * Neither is sensitive — the anon key is designed to be public in browser code — so the
 * "Sensitive" toggle in Vercel can stay off for these.
 *
 * MULTI-ACCOUNT NOTE: supabase-js doesn't support more than one session per client instance, but
 * it does support multiple independent client instances in one page/tab, each pinned to its own
 * `auth.storageKey` — distinct storage keys keep them from reading/overwriting each other's
 * localStorage entry, and each instance independently runs its own token-refresh timer. That's
 * the mechanism the account switcher (see AuthGate.jsx / lib/accounts.js) is built on: one client
 * instance per held login, memoized here so the same instance is reused across renders/components
 * rather than a fresh one (and a fresh subscription) being created every time.
 *
 * MIGRATION-SAFETY NOTE (read before touching this file): before this feature, no storageKey was
 * ever passed to createClient(), so supabase-js fell back to ITS OWN default, which is derived
 * from the project URL (roughly `sb-<project-ref>-auth-token`). Every already-logged-in user's
 * session sits in their browser's localStorage under that implicit key today. If the "primary"
 * slot below started passing an explicit custom storageKey, every existing session would stop
 * being found on the next deploy — a silent, instant, production-wide logout. So the primary slot
 * (PRIMARY_ACCOUNT_KEY) deliberately omits `storageKey` entirely, letting supabase-js keep
 * deriving the exact same default it always has. Only accounts added AFTER this shipped (via
 * "+ Add account") get an explicit, generated storageKey — see lib/accounts.js#newStorageKey.
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

// Sentinel storageKey standing in for "whatever supabase-js's own default is" — see the migration
// note above. Never pass this string itself as a literal storageKey value to createClient.
export const PRIMARY_ACCOUNT_KEY = "__primary__";

const clientCache = new Map();

// Returns a memoized client for a given account slot. `storageKey` should be either
// PRIMARY_ACCOUNT_KEY (the one pre-existing logged-in-before-this-feature slot) or a generated
// key from lib/accounts.js#newStorageKey (any account added via the switcher). `detectSessionInUrl`
// should be true for at most ONE live client at a time — whichever one is expected to be
// completing an OAuth redirect right now (see AuthGate.jsx / Auth.jsx's use of it) — passing true
// for more than one risks two clients racing to consume the same auth code from the URL.
export function getAccountClient(storageKey = PRIMARY_ACCOUNT_KEY, { detectSessionInUrl = false } = {}) {
  const cacheKey = storageKey;
  if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);
  const authOptions =
    storageKey === PRIMARY_ACCOUNT_KEY
      ? { persistSession: true, autoRefreshToken: true, detectSessionInUrl }
      : { storageKey, persistSession: true, autoRefreshToken: true, detectSessionInUrl };
  const client = createClient(url || "https://placeholder.supabase.co", anonKey || "placeholder", {
    auth: authOptions,
  });
  clientCache.set(cacheKey, client);
  return client;
}

// Back-compat singleton for any code not yet multi-account-aware. This is the primary slot with
// detectSessionInUrl enabled, matching the one and only client that used to exist in this file —
// existing imports of `supabase` keep working exactly as before.
export const supabase = getAccountClient(PRIMARY_ACCOUNT_KEY, { detectSessionInUrl: true });
