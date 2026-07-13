import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "../api";
import { toast } from "../toast";

type Phase = "checking" | "locked" | "open";

// AuthGate blocks the app behind a token login when the server requires one.
// When auth is disabled (dev), it renders children immediately. A 401 from any
// API call flips it back to the locked state.
export function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);

  const check = async () => {
    try {
      const { required, authed } = await api.authState();
      setPhase(!required || authed ? "open" : "locked");
    } catch {
      // If even /api/auth fails, assume open rather than hard-locking the UI.
      setPhase("open");
    }
  };

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase("locked"));
    check();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.login(token.trim());
      setToken("");
      setPhase("open");
    } catch {
      toast.error("Invalid token");
    } finally {
      setBusy(false);
    }
  };

  if (phase === "checking") return null;
  if (phase === "open") return <>{children}</>;

  return (
    <div className="auth-gate">
      <form className="auth-card" onSubmit={submit}>
        <h1>Studio</h1>
        <p className="small">This instance is protected. Enter the access token to continue.</p>
        <input
          type="password"
          value={token}
          autoFocus
          placeholder="Access token"
          onChange={(e) => setToken(e.target.value)}
        />
        <button type="submit" disabled={busy || !token.trim()}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
