import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAccountClient, supabaseConfigured, PRIMARY_ACCOUNT_KEY } from "./lib/supabaseClient";
import {
  loadKnownAccounts,
  upsertKnownAccount,
  removeKnownAccount,
  getActiveAccountKey,
  setActiveAccountKey as persistActiveAccountKey,
  workspaceKeyFor,
  ADD_ACCOUNT_PARAM,
} from "./lib/accounts";
import AddAccountScreen from "./AddAccount";
import AuthScreen from "./Auth";
import WorkspaceGate from "./WorkspaceGate";

// localStorage key an invite link's token gets stashed under — see the capture effect below and
// WorkspaceGate.jsx (which consumes it once a session exists). localStorage rather than only the
// URL because an invite link often arrives BEFORE the person has an account at all: they land
// here, click through to sign up (possibly via an OAuth provider that does a full-page redirect
// away and back), and the `?invite=` query param wouldn't reliably survive that round trip —
// localStorage does.
export const PENDING_INVITE_KEY = "paidhq_pending_invite_token";

function LoadingScreen() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Inter,sans-serif",
        color: "#8F8F8F",
        fontSize: 13,
      }}
    >
      Loading…
    </div>
  );
}

// Top of the auth stack. Used to own a single Supabase session; now owns a SET of them — every
// account someone is simultaneously signed into in this browser (personal email, a client's login,
// etc.) — and hands the currently-active one down to WorkspaceGate exactly like before, so
// everything below (WorkspaceGate, BudgetHQ) only has to understand "one session," never "which of
// several." See lib/accounts.js and lib/supabaseClient.js for the storage-key-per-account
// mechanics this is built on.
//
// This component itself renders one of two completely separate trees depending on whether this
// specific browser TAB was opened as an "+ Add account" tab (?paidhq_add_account=1 — see
// handleAddAccount below and AddAccount.jsx) — that's a fully isolated flow that never touches
// whichever account is active in whatever tab opened it, so it's kept as a different component
// entirely rather than a conditional branch threaded through the hook-heavy logic below.
export default function AuthGate() {
  const isAddAccountTab = new URLSearchParams(window.location.search).get(ADD_ACCOUNT_PARAM) === "1";
  if (isAddAccountTab) return <AddAccountScreen />;
  return <AuthGateMain />;
}

function AuthGateMain() {
  // Captures ?invite=<token> off the URL into localStorage and strips it from the visible URL, so
  // it's not lost regardless of what the sign-in/sign-up flow does next (including a full OAuth
  // redirect away from this page entirely). Runs once, before we even know if anyone's logged in.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const token = params.get("invite");
      if (token) {
        localStorage.setItem(PENDING_INVITE_KEY, token);
        params.delete("invite");
        const rest = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
      }
    } catch {
      /* ignore — worst case the invite link just has to be reopened */
    }
  }, []);

  // Account metadata (email/userId/storageKey) — NOT tokens, those live inside each account's own
  // Supabase client. Starts from whatever was persisted last session; the hydration effect below
  // fills in the actual session objects and keeps this list in sync as accounts are added/removed.
  const [accounts, setAccounts] = useState(() => loadKnownAccounts());
  const [activeAccountKey, setActiveAccountKeyState] = useState(() => getActiveAccountKey());
  // { [storageKey]: session | null | undefined } — undefined while that account's initial
  // getSession() check is still in flight, null once known signed-out, the session object once
  // signed in. Keyed by storageKey rather than user id since a slot can be signed out and re-used.
  const [sessionsByKey, setSessionsByKey] = useState({});

  // Mirrors activeAccountKey for effects/callbacks below that shouldn't re-run or be recreated
  // just because the active account changed, but still need the CURRENT value rather than
  // whatever it was when they were defined — same pattern BudgetHQ.jsx uses for `session` itself,
  // after a real production bug there (see that file's sessionRef comment) taught this the hard
  // way: closures over state inside effects/callbacks with unrelated dependency arrays go stale.
  const activeAccountKeyRef = useRef(activeAccountKey);
  useEffect(() => {
    activeAccountKeyRef.current = activeAccountKey;
  });

  const switchAccount = useCallback((key) => {
    setActiveAccountKeyState(key);
    persistActiveAccountKey(key);
  }, []);

  // Subscribes to every known account's Supabase client (plus the primary slot, always, so a
  // browser with zero known-accounts metadata yet — the state of the world for every user before
  // this feature shipped — still gets checked and silently bootstrapped into the switcher the
  // first time it turns out to have a live session). Each subscription is set up once per
  // storageKey and left running for the component's lifetime, since autoRefreshToken needs the
  // client instance to stay alive to keep silently refreshing a backgrounded account's token —
  // otherwise switching to it later would require a full re-login even though nothing ever
  // actually signed it out.
  const subscriptionsRef = useRef(new Map()); // storageKey -> unsubscribe fn

  useEffect(() => {
    const keys = new Set([PRIMARY_ACCOUNT_KEY, ...accounts.map((a) => a.storageKey)]);

    keys.forEach((key) => {
      if (subscriptionsRef.current.has(key)) return;
      const client = getAccountClient(key, { detectSessionInUrl: key === PRIMARY_ACCOUNT_KEY });

      const applySession = (nextSession) => {
        setSessionsByKey((prev) => ({ ...prev, [key]: nextSession ?? null }));
        if (nextSession?.user) {
          setAccounts(() =>
            upsertKnownAccount({
              storageKey: key,
              userId: nextSession.user.id,
              email: nextSession.user.email,
            })
          );
          // First account this browser has ever seen (or the first to resolve after a stale
          // active-account key pointed nowhere) becomes active by default — nobody should land on
          // a blank "you have zero accounts" state after successfully signing in.
          if (!activeAccountKeyRef.current) {
            switchAccount(key);
          }
        }
      };

      client.auth.getSession().then(({ data }) => applySession(data.session ?? null));
      const { data: sub } = client.auth.onAuthStateChange((_event, nextSession) => {
        applySession(nextSession);
      });
      subscriptionsRef.current.set(key, () => sub.subscription.unsubscribe());
    });

    // Tear down subscriptions for accounts that were removed (sign-out-of-account) since the last
    // time this ran.
    subscriptionsRef.current.forEach((unsub, key) => {
      if (!keys.has(key)) {
        unsub();
        subscriptionsRef.current.delete(key);
        setSessionsByKey((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    });
  }, [accounts, switchAccount]);

  useEffect(
    () => () => {
      subscriptionsRef.current.forEach((unsub) => unsub());
    },
    []
  );

  // Picks up an account added from a "+ Add account" tab (a completely separate JS context) —
  // writing to paidhq_known_accounts there fires a native `storage` event in every OTHER
  // same-origin tab, which is what lets this tab notice the new account without a manual reload.
  useEffect(() => {
    function onStorage(e) {
      if (e.key === "paidhq_known_accounts") {
        setAccounts(loadKnownAccounts());
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const handleAddAccount = useCallback(() => {
    const url = `${window.location.origin}${window.location.pathname}?${ADD_ACCOUNT_PARAM}=1`;
    window.open(url, "_blank", "noopener");
  }, []);

  const handleSignOutAccount = useCallback(
    async (key) => {
      try {
        await getAccountClient(key).auth.signOut();
      } catch {
        /* ignore — the account gets removed from the switcher regardless */
      }
      const remaining = removeKnownAccount(key);
      setAccounts(remaining);
      setSessionsByKey((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      if (activeAccountKeyRef.current === key) {
        switchAccount(remaining[0]?.storageKey || null);
      }
    },
    [switchAccount]
  );

  // Invoked by WorkspaceGate when a pending invite gets accepted against a DIFFERENT held account
  // than the one currently active (see that file's invite effect) — flips the switcher over to it
  // and pre-seeds ITS namespaced "active workspace" localStorage entry with the workspace that was
  // just joined, so the freshly-mounted WorkspaceGate for that account lands there immediately
  // instead of whatever it last had active.
  const handleInviteAcceptedForOtherAccount = useCallback(
    (key, workspaceId) => {
      try {
        localStorage.setItem(workspaceKeyFor(key), workspaceId);
      } catch {
        /* ignore */
      }
      switchAccount(key);
    },
    [switchAccount]
  );

  const effectiveActiveKey = activeAccountKey || PRIMARY_ACCOUNT_KEY;
  const activeSession = sessionsByKey[effectiveActiveKey];

  const otherAccountSessions = useMemo(() => {
    const map = {};
    Object.entries(sessionsByKey).forEach(([key, sess]) => {
      if (key !== effectiveActiveKey && sess) map[key] = sess;
    });
    return map;
  }, [sessionsByKey, effectiveActiveKey]);

  if (!supabaseConfigured) {
    return <AuthScreen />;
  }

  if (activeSession === undefined) {
    return <LoadingScreen />;
  }

  if (!activeSession) {
    // Nobody's signed in under this slot. If it's a previously-known account whose refresh token
    // died (revoked, expired from disuse) rather than a genuinely fresh browser, say so and scope
    // the sign-in form to THAT account's client, so re-authenticating fills the same slot back in
    // rather than landing in a brand new one.
    const knownAccount = accounts.find((a) => a.storageKey === effectiveActiveKey);
    const client = getAccountClient(effectiveActiveKey, { detectSessionInUrl: effectiveActiveKey === PRIMARY_ACCOUNT_KEY });
    return (
      <AuthScreen
        client={client}
        heading={knownAccount ? `Sign in again as ${knownAccount.email}` : undefined}
      />
    );
  }

  return (
    <WorkspaceGate
      key={effectiveActiveKey}
      session={activeSession}
      onSignOut={() => handleSignOutAccount(effectiveActiveKey)}
      accountKey={effectiveActiveKey}
      accounts={accounts}
      onSwitchAccount={switchAccount}
      onAddAccount={handleAddAccount}
      onSignOutAccount={handleSignOutAccount}
      otherAccountSessions={otherAccountSessions}
      onInviteAcceptedForOtherAccount={handleInviteAcceptedForOtherAccount}
    />
  );
}
