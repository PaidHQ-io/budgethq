import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";
import AuthScreen from "./Auth";
import WorkspaceGate from "./WorkspaceGate";

// localStorage key an invite link's token gets stashed under — see the capture effect below and
// WorkspaceGate.jsx (which consumes it once a session exists). localStorage rather than only the
// URL because an invite link often arrives BEFORE the person has an account at all: they land
// here, click through to sign up (possibly via an OAuth provider that does a full-page redirect
// away and back), and the `?invite=` query param wouldn't reliably survive that round trip —
// localStorage does.
export const PENDING_INVITE_KEY = "paidhq_pending_invite_token";

// Owns the Supabase session for the whole app. `session` is `undefined` while the initial check
// is in flight, `null` once we know for sure the user is signed out, or the actual session object
// once signed in. Workspace selection lives one level down in WorkspaceGate — this component only
// cares about "is someone logged in," not which workspace they're in.
export default function AuthGate() {
  // Lazy initializer instead of setting this in the effect below — avoids a synchronous
  // setState call during the effect when Supabase isn't configured at all.
  const [session, setSession] = useState(() => (supabaseConfigured ? undefined : null));

  // Runs once, before we even know if anyone's logged in — captures ?invite=<token> off the URL
  // into localStorage and strips it from the visible URL, so it's not lost regardless of what the
  // sign-in/sign-up flow does next (including a full OAuth redirect away from this page entirely).
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

  useEffect(() => {
    if (!supabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) {
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

  if (!session) {
    return <AuthScreen />;
  }

  return <WorkspaceGate session={session} onSignOut={() => supabase.auth.signOut()} />;
}
