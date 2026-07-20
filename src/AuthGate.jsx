import { useEffect, useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";
import AuthScreen from "./Auth";
import WorkspaceGate from "./WorkspaceGate";

// Owns the Supabase session for the whole app. `session` is `undefined` while the initial check
// is in flight, `null` once we know for sure the user is signed out, or the actual session object
// once signed in. Workspace selection lives one level down in WorkspaceGate — this component only
// cares about "is someone logged in," not which workspace they're in.
export default function AuthGate() {
  // Lazy initializer instead of setting this in the effect below — avoids a synchronous
  // setState call during the effect when Supabase isn't configured at all.
  const [session, setSession] = useState(() => (supabaseConfigured ? undefined : null));

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
