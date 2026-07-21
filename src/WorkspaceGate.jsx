import { useCallback, useEffect, useState } from "react";
import { listWorkspaces, createWorkspace, grantEntitlement, acceptInvite } from "./lib/coreApi";
import { PENDING_INVITE_KEY } from "./AuthGate";
import BudgetHQ from "./BudgetHQ";

// Standalone subset of BudgetHQ's theme tokens — see Auth.jsx for why this isn't imported from
// BudgetHQ.jsx directly.
const T = {
  bg: "#FAFAFA",
  surface: "#FFFFFF",
  surfaceEl: "#FAFAFA",
  border: "#EAEAEA",
  text: "#171717",
  textSub: "#666666",
  textMuted: "#8F8F8F",
  accent: "#FF7A59",
  onAccent: "#171717",
  accentBg: "rgba(255,122,89,0.1)",
  accentBorder: "rgba(255,122,89,0.3)",
  danger: "#E5484D",
  dangerBg: "rgba(229,72,77,0.08)",
  dangerBorder: "rgba(229,72,77,0.24)",
  success: "#0C7A43",
  successBg: "rgba(12,122,67,0.08)",
  successBorder: "rgba(12,122,67,0.24)",
};

const ACTIVE_WORKSPACE_KEY = "paidhq_active_workspace_id";

const KIND_OPTIONS = [
  { key: "inhouse", label: "In-house brand", hint: "I manage paid media for a company I work at." },
  { key: "agency_client", label: "Agency client", hint: "This is one of my agency's client accounts." },
  { key: "consultant_client", label: "Consulting client", hint: "This is a client I consult for." },
];

// Fixed top banner reporting the outcome of an invite-acceptance attempt (see the effect in
// WorkspaceGate below) — rendered above whichever screen WorkspaceGate is currently showing
// (loading/error/create-workspace/the actual product), since accepting an invite can happen
// during any of those depending on whether the person already had an account and workspaces.
function InviteStatusBanner({ status, onDismiss }) {
  if (!status) return null;
  const accepting = status === "accepting";
  const isError = !accepting && status.error;
  const bg = accepting ? T.accentBg : isError ? T.dangerBg : T.successBg;
  const border = accepting ? T.accentBorder : isError ? T.dangerBorder : T.successBorder;
  const color = accepting ? T.text : isError ? T.danger : T.success;
  const message = accepting
    ? "Joining workspace…"
    : isError
    ? status.error
    : `You've joined "${status.success}"`;
  return (
    <div
      style={{
        position: "fixed",
        top: 12,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 14px",
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 8,
        color,
        fontSize: 13,
        fontWeight: 500,
        fontFamily: "Inter,sans-serif",
        boxShadow: "0 4px 16px rgba(0,0,0,0.08)",
        maxWidth: "min(90vw, 480px)",
      }}
    >
      <span>{message}</span>
      {!accepting && (
        <span onClick={onDismiss} style={{ cursor: "pointer", opacity: 0.6, fontSize: 12 }}>
          ✕
        </span>
      )}
    </div>
  );
}

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

function CreateWorkspaceScreen({ name, setName, kind, setKind, onSubmit, loading, error, onCancel, onSignOut }) {
  return (
    <CenteredScreen>
      <form
        onSubmit={onSubmit}
        style={{
          width: 420,
          maxWidth: "100%",
          padding: 32,
          border: `1px solid ${T.border}`,
          borderRadius: 8,
          background: T.surface,
          boxSizing: "border-box",
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 4 }}>
          {onCancel ? "New workspace" : "Set up your first workspace"}
        </div>
        <div style={{ fontSize: 13, color: T.textSub, marginBottom: 22, lineHeight: 1.5 }}>
          A workspace is one client account, brand, or company you manage paid media for. You can
          add more later — agencies and consultants usually end up with one per client.
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

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 5 }}>
          Workspace name
        </label>
        <input
          autoFocus
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Acme Inc, or Client — Nike"
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "#FFFFFF",
            border: `1px solid ${T.border}`,
            borderRadius: 6,
            color: T.text,
            padding: "9px 10px",
            fontSize: 13,
            outline: "none",
            marginBottom: 16,
            fontFamily: "Inter,sans-serif",
          }}
        />

        <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: T.textMuted, marginBottom: 8 }}>
          What kind of workspace is this?
        </label>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 22 }}>
          {KIND_OPTIONS.map((opt) => (
            <div
              key={opt.key}
              onClick={() => setKind(opt.key)}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 2,
                padding: "9px 12px",
                borderRadius: 8,
                cursor: "pointer",
                background: kind === opt.key ? T.accentBg : "transparent",
                border: `1px solid ${kind === opt.key ? T.accentBorder : T.border}`,
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{opt.label}</span>
              <span style={{ fontSize: 11, color: T.textSub }}>{opt.hint}</span>
            </div>
          ))}
        </div>

        <button
          type="submit"
          disabled={loading || !name.trim()}
          style={{
            width: "100%",
            background: T.accent,
            color: T.onAccent,
            border: "1px solid transparent",
            borderRadius: 6,
            padding: "10px 0",
            fontSize: 13,
            fontWeight: 600,
            cursor: loading ? "default" : "pointer",
            opacity: loading || !name.trim() ? 0.6 : 1,
            fontFamily: "Inter,sans-serif",
          }}
        >
          {loading ? "Creating…" : "Create workspace"}
        </button>

        <div
          style={{
            marginTop: 16,
            fontSize: 12,
            color: T.textSub,
            display: "flex",
            justifyContent: onCancel ? "space-between" : "flex-end",
          }}
        >
          {onCancel && (
            <span style={{ cursor: "pointer" }} onClick={onCancel}>
              ← Cancel
            </span>
          )}
          {onSignOut && (
            <span style={{ cursor: "pointer" }} onClick={onSignOut}>
              Sign out
            </span>
          )}
        </div>
      </form>
    </CenteredScreen>
  );
}

// Sits between AuthGate (owns the Supabase session) and BudgetHQ (the actual product). Owns the
// list of workspaces the signed-in user belongs to, which one is "active," and the create-a-
// workspace flow — all via paidhq-core's API, never talking to Postgres directly (that's core's
// job; every product goes through its API for workspace/entitlement data).
export default function WorkspaceGate({ session, onSignOut }) {
  const [workspaces, setWorkspaces] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState(() => {
    try {
      return localStorage.getItem(ACTIVE_WORKSPACE_KEY);
    } catch {
      return null;
    }
  });
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState("inhouse");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  // null = nothing pending / already resolved this session; "accepting" while in flight;
  // {error} or {success: workspaceName} once resolved, so the banner below can tell the person
  // what happened before it's dismissed.
  const [inviteStatus, setInviteStatus] = useState(null);

  // Note: doesn't clear loadError synchronously before the fetch starts (that would be a
  // synchronous setState call from directly within the mount effect below, which
  // eslint-plugin-react-hooks flags as a cascading-render risk) — instead, a successful
  // refresh clears it as part of the same state update as the new workspace list, and a
  // failed refresh just replaces the previous error with the new one. Either way the error
  // banner never gets stuck showing a stale error after a successful retry.
  const refresh = useCallback(() => {
    listWorkspaces(session)
      .then((rows) => {
        setWorkspaces(rows);
        setLoadError("");
      })
      .catch((err) => setLoadError(err.message || "Couldn't load your workspaces."));
  }, [session]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Consumes a pending invite token stashed in localStorage (see AuthGate.jsx's capture effect)
  // now that we know for sure someone's logged in. Re-runs whenever `session` changes, so if the
  // person who clicked the invite link was already signed into a DIFFERENT account when it fired,
  // signing out and back in as the right one retries it automatically.
  //
  // The token is only cleared on success, or on a failure that means it's genuinely dead (invalid/
  // already-used/expired — accept.js returns 404/409/410 for those). A 403 specifically means "this
  // invite is for a different email than whoever's signed in right now" — that's recoverable, so
  // the token has to survive it, or the invite is unrecoverably lost the instant someone opens the
  // link while signed into the wrong account (a very easy thing to do by accident).
  useEffect(() => {
    let token;
    try {
      token = localStorage.getItem(PENDING_INVITE_KEY);
    } catch {
      return;
    }
    if (!token) return;
    setInviteStatus("accepting");
    acceptInvite(session, token)
      .then((result) => {
        try {
          localStorage.removeItem(PENDING_INVITE_KEY);
        } catch {
          /* ignore */
        }
        setInviteStatus({ success: result.workspaceName });
        setTimeout(() => setInviteStatus(null), 5000);
        refresh();
        selectWorkspace(result.workspaceId);
      })
      .catch((err) => {
        if (err.status !== 403) {
          try {
            localStorage.removeItem(PENDING_INVITE_KEY);
          } catch {
            /* ignore */
          }
        }
        setInviteStatus({ error: err.message || "Couldn't accept that invite." });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Keep the active selection valid — falls back to the first workspace if the stored id is
  // stale (deleted, or from a different account) or nothing was stored yet.
  useEffect(() => {
    if (!workspaces || !workspaces.length) return;
    if (activeId && workspaces.some((w) => w.id === activeId)) return;
    selectWorkspace(workspaces[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaces]);

  function selectWorkspace(id) {
    setActiveId(id);
    try {
      localStorage.setItem(ACTIVE_WORKSPACE_KEY, id);
    } catch {
      /* ignore */
    }
  }

  async function handleCreate(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setCreating(true);
    setCreateError("");
    try {
      const workspace = await createWorkspace(session, { name: newName.trim(), kind: newKind });
      // Whoever creates a workspace from inside BudgetHQ gets an immediate BudgetHQ trial for
      // it — signing up through the product and then hitting a paywall before touching it at
      // all would be a bad first impression. Turning this into real billing (expiring trials,
      // upgrading to paid) is a follow-up for when Stripe is wired in; this just unblocks
      // actually using the product today.
      await grantEntitlement(session, workspace.id, { product: "budgethq", plan: "trial", status: "trialing" });
      setNewName("");
      setShowCreateForm(false);
      selectWorkspace(workspace.id);
      refresh();
    } catch (err) {
      setCreateError(err.message || "Couldn't create that workspace.");
    } finally {
      setCreating(false);
    }
  }

  const banner = <InviteStatusBanner status={inviteStatus} onDismiss={() => setInviteStatus(null)} />;

  if (loadError) {
    return (
      <>
        {banner}
        <CenteredScreen>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
            <div
              style={{
                padding: "12px 16px",
                background: T.dangerBg,
                border: `1px solid ${T.dangerBorder}`,
                borderRadius: 8,
                color: T.danger,
                fontSize: 13,
                maxWidth: 420,
                textAlign: "center",
              }}
            >
              {loadError}
            </div>
            <button
              onClick={refresh}
              style={{
                background: "transparent",
                border: `1px solid ${T.border}`,
                borderRadius: 6,
                padding: "7px 16px",
                fontSize: 12,
                color: T.text,
                cursor: "pointer",
                fontFamily: "Inter,sans-serif",
              }}
            >
              Try again
            </button>
          </div>
        </CenteredScreen>
      </>
    );
  }

  if (workspaces === null) {
    return (
      <>
        {banner}
        <CenteredScreen>
          <div style={{ color: T.textMuted, fontSize: 13, fontFamily: "Inter,sans-serif" }}>
            Loading your workspaces…
          </div>
        </CenteredScreen>
      </>
    );
  }

  if (!workspaces.length || showCreateForm) {
    return (
      <>
        {banner}
        <CreateWorkspaceScreen
          name={newName}
          setName={setNewName}
          kind={newKind}
          setKind={setNewKind}
          onSubmit={handleCreate}
          loading={creating}
          error={createError}
          onCancel={workspaces.length ? () => setShowCreateForm(false) : null}
          onSignOut={onSignOut}
        />
      </>
    );
  }

  const active = workspaces.find((w) => w.id === activeId) || workspaces[0];

  return (
    <>
      {banner}
      <BudgetHQ
        session={session}
        onSignOut={onSignOut}
        workspace={active}
        workspaces={workspaces}
        onSwitchWorkspace={selectWorkspace}
        onCreateWorkspace={() => setShowCreateForm(true)}
      />
    </>
  );
}
