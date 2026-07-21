import { useEffect, useMemo, useState } from "react";
import { getAccountClient } from "./lib/supabaseClient";
import { upsertKnownAccount, newStorageKey, ADD_ACCOUNT_PARAM, ADD_ACCOUNT_SLOT_PARAM } from "./lib/accounts";
import AuthScreen from "./Auth";

// Standalone subset of the shared theme tokens — same convention Auth.jsx/WorkspaceGate.jsx
// already use for screens that render before the main product's theme context exists.
const T = {
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  border: "#EAEAEA",
  text: "#171717",
  textSub: "#666666",
  accent: "#FF7A59",
  onAccent: "#171717",
};

function CenteredScreen({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background: T.bg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "Inter,sans-serif",
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

// Rendered in a dedicated browser tab opened via "+ Add account" (AuthGate.jsx's handleAddAccount
// opens `${origin}?paidhq_add_account=1` in a new tab). Deliberately isolated from the main app's
// session tree — this tab's only job is to sign someone into a BRAND NEW account slot and register
// it into the shared `paidhq_known_accounts` localStorage entry, which the ORIGINAL tab picks up
// via a `storage` event listener (see AuthGate.jsx) without ever touching whichever account is
// active there.
//
// Doing this in a separate tab rather than an in-page modal sidesteps the hardest part of
// multi-account + OAuth: signInWithOAuth does a full-page redirect away and back, and no JS memory
// survives that round trip. Rather than stash "which account slot was mid-auth" in sessionStorage,
// the slot's storageKey travels straight through the OAuth redirectTo URL's query string (Supabase
// preserves it through the round trip), so this component just re-reads `paidhq_slot` off the URL
// on the way back — stateless, and it even survives the tab being closed and the link reopened.
export default function AddAccountScreen() {
  const slot = useMemo(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get(ADD_ACCOUNT_SLOT_PARAM) || newStorageKey();
  }, []);
  // detectSessionInUrl: true is safe here even though the primary client also has it true —
  // they're different storageKeys, so each only ever recognizes an OAuth code meant for it
  // (Supabase's code exchange is tied to a PKCE verifier stored under that same storageKey).
  const client = useMemo(() => getAccountClient(slot, { detectSessionInUrl: true }), [slot]);
  const redirectTo = `${window.location.origin}${window.location.pathname}?${ADD_ACCOUNT_PARAM}=1&${ADD_ACCOUNT_SLOT_PARAM}=${slot}`;

  const [session, setSession] = useState(undefined); // undefined = loading, null = not signed in yet

  useEffect(() => {
    client.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = client.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, [client]);

  useEffect(() => {
    if (session?.user) {
      upsertKnownAccount({ storageKey: slot, userId: session.user.id, email: session.user.email });
    }
  }, [session, slot]);

  if (session === undefined) {
    return (
      <CenteredScreen>
        <div style={{ color: T.textSub, fontSize: 13 }}>Loading…</div>
      </CenteredScreen>
    );
  }

  if (!session) {
    return <AuthScreen client={client} redirectTo={redirectTo} heading="Add another PaidHQ account" />;
  }

  return (
    <CenteredScreen>
      <div
        style={{
          width: 380,
          maxWidth: "100%",
          padding: 32,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          background: T.surface,
          boxSizing: "border-box",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 10 }}>
          Account connected
        </div>
        <div style={{ fontSize: 13, color: T.textSub, lineHeight: 1.6, marginBottom: 22 }}>
          Signed in as <strong style={{ color: T.text }}>{session.user?.email}</strong>. Switch to it
          from the account menu in your other BudgetHQ tab — then you can close this one.
        </div>
        <button
          onClick={() => window.close()}
          style={{
            width: "100%",
            background: T.accent,
            color: T.onAccent,
            border: "1px solid transparent",
            borderRadius: 6,
            padding: "10px 0",
            fontSize: 13,
            fontWeight: 600,
            cursor: "pointer",
            fontFamily: "Inter,sans-serif",
          }}
        >
          Close this tab
        </button>
      </div>
    </CenteredScreen>
  );
}
