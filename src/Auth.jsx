import { useState } from "react";
import { supabase, supabaseConfigured } from "./lib/supabaseClient";

// Small standalone subset of BudgetHQ's VaultHQ-matched theme tokens — kept local rather than
// imported from BudgetHQ.jsx since this screen renders before any workspace/session data exists
// and shouldn't depend on that file's internals.
const T = {
  bg: "#FFFFFF",
  surface: "#FFFFFF",
  surfaceEl: "#F7F7F5",
  border: "#E9E9E7",
  text: "#37352F",
  textSub: "#787774",
  textMuted: "#9B9A97",
  accent: "#2383E2",
  accentHover: "#1A73CE",
  danger: "#E03E3E",
  dangerBg: "rgba(224,62,62,0.1)",
  dangerBorder: "rgba(224,62,62,0.25)",
  success: "#2F9E44",
  successBg: "rgba(47,158,68,0.1)",
  successBorder: "rgba(47,158,68,0.25)",
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

export default function AuthScreen() {
  const [mode, setMode] = useState("signin"); // "signin" | "signup" | "forgot"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  function switchMode(next) {
    setMode(next);
    setError("");
    setNotice("");
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
