import { useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";

// Small standalone subset of BudgetHQ's Vercel-matched theme tokens — kept local rather than
// imported from BudgetHQ.jsx since this screen renders before any workspace/session data exists
// and shouldn't depend on that file's internals.
const T = {
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceEl: "#FAFAFA",
  border: "#EAEAEA",
  text: "#171717",
  textSub: "#666666",
  textMuted: "#8F8F8F",
  accent: "#000000",
  accentHover: "#333333",
  danger: "#E5484D",
  dangerBg: "rgba(229,72,77,0.08)",
  dangerBorder: "rgba(229,72,77,0.24)",
  success: "#0C7A43",
  successBg: "rgba(12,122,67,0.08)",
  successBorder: "rgba(12,122,67,0.24)",
};

const inputStyle = {
  width: "100%",
  boxSizing: "border-box",
  background: "#FFFFFF",
  border: `1px solid ${T.border}`,
  borderRadius: 6,
  color: T.text,
  padding: "9px 10px",
  fontSize: 13,
  outline: "none",
  marginBottom: 14,
  fontFamily: "Inter,sans-serif",
};

const labelStyle = {
  display: "block",
  fontSize: 11,
  fontWeight: 600,
  color: T.textMuted,
  marginBottom: 5,
  fontFamily: "Inter,sans-serif",
};

// Minimal recognizable renditions of each provider's mark — not pixel-exact brand assets, just
// enough to read at a glance next to "Continue with X" text.
const GoogleIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18">
    <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844c-.209 1.125-.843 2.078-1.796 2.717v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332C2.438 15.983 5.482 18 9 18z" />
    <path fill="#FBBC05" d="M3.964 10.71c-.18-.54-.282-1.117-.282-1.71s.102-1.17.282-1.71V4.958H.957C.347 6.173 0 7.548 0 9s.348 2.827.957 4.042l3.007-2.332z" />
    <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0 5.482 0 2.438 2.017.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" />
  </svg>
);
const MicrosoftIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16">
    <rect x="0" y="0" width="7.3" height="7.3" fill="#F25022" />
    <rect x="8.7" y="0" width="7.3" height="7.3" fill="#7FBA00" />
    <rect x="0" y="8.7" width="7.3" height="7.3" fill="#00A4EF" />
    <rect x="8.7" y="8.7" width="7.3" height="7.3" fill="#FFB900" />
  </svg>
);
const FacebookIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18">
    <circle cx="9" cy="9" r="9" fill="#1877F2" />
    <path fill="#fff" d="M12.2 9.3h-2v6.4H7.7V9.3H6.2V7.2h1.5V5.8c0-1.5.9-2.4 2.4-2.4h1.8V5.4h-1.2c-.4 0-.6.2-.6.6v1.2h1.9l-.3 2.1z" />
  </svg>
);
const LinkedInIcon = () => (
  <svg width="16" height="16" viewBox="0 0 18 18">
    <rect width="18" height="18" rx="3" fill="#0A66C2" />
    <path fill="#fff" d="M5.9 7.3H3.6v7.1h2.3V7.3zM4.75 6.3a1.33 1.33 0 1 0 0-2.66 1.33 1.33 0 0 0 0 2.66zM14.4 14.4h-2.3v-3.7c0-.9-.3-1.5-1.1-1.5-.6 0-.95.4-1.1.8-.06.15-.08.35-.08.55v3.85H7.5s.03-6.25 0-7.1h2.3v1c.3-.47.85-1.14 2.05-1.14 1.5 0 2.55 1 2.55 3.05v3.2z" />
  </svg>
);

// Supabase's provider keys, not display labels — passed straight to signInWithOAuth(). LinkedIn
// uses "linkedin_oidc" (Supabase's newer OIDC-based provider) — the older "linkedin" key is
// deprecated since LinkedIn retired the API it depended on.
const OAUTH_PROVIDERS = [
  { key: "google", label: "Continue with Google", Icon: GoogleIcon },
  { key: "azure", label: "Continue with Microsoft", Icon: MicrosoftIcon },
  { key: "linkedin_oidc", label: "Continue with LinkedIn", Icon: LinkedInIcon },
  { key: "facebook", label: "Continue with Facebook", Icon: FacebookIcon },
];

export default function AuthScreen() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [oauthLoading, setOauthLoading] = useState(null); // provider key currently redirecting, or null
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function switchMode(next) {
    setMode(next);
    setError("");
    setNotice("");
  }

  async function handleOAuth(provider) {
    setError("");
    setNotice("");
    setOauthLoading(provider);
    try {
      const { error: err } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin },
      });
      if (err) throw err;
      // On success the browser navigates away to the provider immediately — nothing left to do
      // here. oauthLoading is intentionally not reset in that case (page is about to unload).
    } catch (err) {
      setError(err.message || "Something went wrong.");
      setOauthLoading(null);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setNotice("");
    setLoading(true);
    try {
      if (mode === "signin") {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
      } else if (mode === "signup") {
        const { error: err } = await supabase.auth.signUp({ email, password });
        if (err) throw err;
        setNotice("Check your email to confirm your account, then sign in.");
        setMode("signin");
      } else if (mode === "forgot") {
        const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: window.location.origin,
        });
        if (err) throw err;
        setNotice("Password reset email sent — check your inbox.");
        setMode("signin");
      }
    } catch (err) {
      setError(err.message || "Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  if (!supabaseConfigured) {
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
        <div
          style={{
            maxWidth: 420,
            padding: "18px 20px",
            background: T.dangerBg,
            border: `1px solid ${T.dangerBorder}`,
            borderRadius: 8,
            color: T.danger,
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          BudgetHQ isn't configured for sign-in yet — VITE_SUPABASE_URL and
          VITE_SUPABASE_ANON_KEY are missing from this deployment's environment variables.
        </div>
      </div>
    );
  }

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
      <div
        style={{
          width: 360,
          maxWidth: "100%",
          padding: 32,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          background: T.surface,
          boxSizing: "border-box",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 20 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: T.accent,
              flexShrink: 0,
            }}
          />
          <div style={{ fontSize: 15, fontWeight: 700, color: T.text }}>PaidHQ</div>
        </div>
        <div style={{ fontSize: 13, color: T.textSub, marginBottom: 22 }}>
          {mode === "signin" && "Sign in to BudgetHQ"}
          {mode === "signup" && "Create your PaidHQ account"}
          {mode === "forgot" && "Reset your password"}
        </div>

        {error && (
          <div
            style={{
              padding: "9px 12px",
              background: T.dangerBg,
              border: `1px solid ${T.dangerBorder}`,
              borderRadius: 8,
              marginBottom: 14,
              fontSize: 12,
              color: T.danger,
            }}
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            style={{
              padding: "9px 12px",
              background: T.successBg,
              border: `1px solid ${T.successBorder}`,
              borderRadius: 8,
              marginBottom: 14,
              fontSize: 12,
              color: T.success,
            }}
          >
            {notice}
          </div>
        )}

        {mode !== "forgot" && (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
              {OAUTH_PROVIDERS.map(({ key, label, Icon }) => (
                <button
                  key={key}
                  type="button"
                  disabled={Boolean(oauthLoading)}
                  onClick={() => handleOAuth(key)}
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 10,
                    background: "#FFFFFF",
                    border: `1px solid ${T.border}`,
                    borderRadius: 6,
                    padding: "9px 0",
                    fontSize: 13,
                    fontWeight: 500,
                    color: T.text,
                    cursor: oauthLoading ? "default" : "pointer",
                    opacity: oauthLoading && oauthLoading !== key ? 0.5 : 1,
                    fontFamily: "Inter,sans-serif",
                  }}
                >
                  <Icon />
                  {oauthLoading === key ? "Redirecting…" : label}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 18 }}>
              <div style={{ flex: 1, height: 1, background: T.border }} />
              <span style={{ fontSize: 11, color: T.textMuted, fontFamily: "Inter,sans-serif" }}>
                or continue with email
              </span>
              <div style={{ flex: 1, height: 1, background: T.border }} />
            </div>
          </>
        )}

        <form onSubmit={handleSubmit}>
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            style={inputStyle}
          />
          {mode !== "forgot" && (
            <>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                required
                minLength={6}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                style={{ ...inputStyle, marginBottom: 20 }}
              />
            </>
          )}

          <button
            type="submit"
            disabled={loading}
            style={{
              width: "100%",
              background: T.accent,
              color: "#FFFFFF",
              border: "1px solid transparent",
              borderRadius: 6,
              padding: "10px 0",
              fontSize: 13,
              fontWeight: 600,
              cursor: loading ? "default" : "pointer",
              opacity: loading ? 0.6 : 1,
              fontFamily: "Inter,sans-serif",
            }}
          >
            {loading
              ? "Please wait…"
              : mode === "signin"
              ? "Sign in"
              : mode === "signup"
              ? "Create account"
              : "Send reset link"}
          </button>
        </form>

        <div
          style={{
            marginTop: 18,
            fontSize: 12,
            color: T.accent,
            display: "flex",
            justifyContent: "space-between",
            fontFamily: "Inter,sans-serif",
          }}
        >
          {mode === "signin" && (
            <>
              <span style={{ cursor: "pointer" }} onClick={() => switchMode("signup")}>
                Create an account
              </span>
              <span style={{ cursor: "pointer", color: T.textSub }} onClick={() => switchMode("forgot")}>
                Forgot password?
              </span>
            </>
          )}
          {mode !== "signin" && (
            <span style={{ cursor: "pointer" }} onClick={() => switchMode("signin")}>
              ← Back to sign in
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
