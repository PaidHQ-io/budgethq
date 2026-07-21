/**
 * localStorage bookkeeping for the multi-account switcher. Stores METADATA only — email, the
 * Supabase user id, and which storageKey slot (see lib/supabaseClient.js) the account's actual
 * session lives under. No tokens are ever written here; those stay inside each Supabase client's
 * own storageKey-scoped localStorage entry, managed entirely by supabase-js.
 *
 * Deliberately plain localStorage reads/writes rather than React state living here — this module
 * is shared by both the main app tab and any "+ Add account" tab (a separate JS context entirely),
 * and a write from one tab fires a native `storage` event in every OTHER same-origin tab, which is
 * exactly how the main tab notices a new account was added without a manual refresh. See
 * AuthGate.jsx's `storage` event listener.
 */
import { PRIMARY_ACCOUNT_KEY } from "./supabaseClient";

const KNOWN_ACCOUNTS_KEY = "paidhq_known_accounts";
const ACTIVE_ACCOUNT_KEY = "paidhq_active_account_key";

export { PRIMARY_ACCOUNT_KEY, KNOWN_ACCOUNTS_KEY };

// Query params used to carry the "+ Add account" flow through a full-page OAuth redirect — see
// AddAccount.jsx for why the storage-key slot has to travel in the URL rather than in memory.
export const ADD_ACCOUNT_PARAM = "paidhq_add_account";
export const ADD_ACCOUNT_SLOT_PARAM = "paidhq_slot";

// [{ storageKey, userId, email }]
export function loadKnownAccounts() {
  try {
    const raw = localStorage.getItem(KNOWN_ACCOUNTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveKnownAccounts(list) {
  try {
    localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    /* ignore — worst case the account has to be re-added to the switcher next session */
  }
}

// Adds a newly-signed-in account, or refreshes its email/userId if it's already known (handles a
// changed email on an existing account, and re-running harmlessly on every auth-state event).
//
// Dedupes by userId, not storageKey: the same real person can end up signed in under TWO storage
// keys (most commonly, "+ Add account" was used a second time for an email already held — either
// already-known secondary account, or the pre-existing legacy primary slot). Rather than showing
// the same person twice in the switcher forever, this keeps exactly one entry per userId and
// reports which storageKey lost out so the caller can sign that duplicate client out entirely —
// no reason to leave two live sessions (and two silent token-refresh timers) running for one
// identity. PRIMARY_ACCOUNT_KEY never loses this tie-break: it's the one slot every
// already-logged-in-before-this-feature user depends on, so a duplicate always resolves in its
// favor regardless of which of the two upsert calls happens to land first.
//
// Returns { accounts, redundantStorageKey } — redundantStorageKey is null when there was no dupe.
export function upsertKnownAccount({ storageKey, userId, email }) {
  const list = loadKnownAccounts();
  const dupe = list.find((a) => a.userId === userId && a.storageKey !== storageKey);

  if (dupe) {
    const redundantStorageKey = storageKey === PRIMARY_ACCOUNT_KEY ? dupe.storageKey : storageKey;
    const keptStorageKey = redundantStorageKey === storageKey ? dupe.storageKey : storageKey;
    const filtered = list.filter((a) => a.storageKey !== redundantStorageKey);
    const idx = filtered.findIndex((a) => a.storageKey === keptStorageKey);
    const entry = { storageKey: keptStorageKey, userId, email };
    if (idx === -1) filtered.push(entry);
    else filtered[idx] = { ...filtered[idx], ...entry };
    saveKnownAccounts(filtered);
    return { accounts: filtered, redundantStorageKey };
  }

  const idx = list.findIndex((a) => a.storageKey === storageKey);
  const entry = { storageKey, userId, email };
  if (idx === -1) list.push(entry);
  else list[idx] = { ...list[idx], ...entry };
  saveKnownAccounts(list);
  return { accounts: list, redundantStorageKey: null };
}

export function removeKnownAccount(storageKey) {
  const list = loadKnownAccounts().filter((a) => a.storageKey !== storageKey);
  saveKnownAccounts(list);
  try {
    localStorage.removeItem(workspaceKeyFor(storageKey));
  } catch {
    /* ignore */
  }
  return list;
}

export function getActiveAccountKey() {
  try {
    return localStorage.getItem(ACTIVE_ACCOUNT_KEY) || null;
  } catch {
    return null;
  }
}

export function setActiveAccountKey(storageKey) {
  try {
    if (storageKey) localStorage.setItem(ACTIVE_ACCOUNT_KEY, storageKey);
    else localStorage.removeItem(ACTIVE_ACCOUNT_KEY);
  } catch {
    /* ignore */
  }
}

// Generates a fresh, unused storage key for a newly-added (non-primary) account. Never returns
// PRIMARY_ACCOUNT_KEY — that sentinel is reserved for the one pre-existing legacy slot.
export function newStorageKey() {
  const rand =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `paidhq-auth-${rand}`;
}

// paidhq_active_workspace_id used to be a single global localStorage key — now namespaced per
// account, so switching accounts doesn't clobber which workspace was active in another account.
// WorkspaceGate.jsx uses this instead of a hardcoded string.
export function workspaceKeyFor(accountStorageKey) {
  return `paidhq_active_workspace_id::${accountStorageKey || PRIMARY_ACCOUNT_KEY}`;
}
