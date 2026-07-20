import { useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "../api";
import { toast } from "../toast";
import { ArcLogo, ThemeToggle } from "./arc/bits";
import { useArcTheme } from "./arc/theme";

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

  return <LockedScreen token={token} setToken={setToken} busy={busy} submit={submit} />;
}

function LockedScreen({
  token,
  setToken,
  busy,
  submit,
}: {
  token: string;
  setToken: (v: string) => void;
  busy: boolean;
  submit: (e: React.FormEvent) => void;
}) {
  const [theme, toggleTheme] = useArcTheme();
  return (
    <div className={`arc${theme === "dark" ? " arc-dark" : ""}`}>
      <ThemeToggle theme={theme} onToggle={toggleTheme} className="arc-auth__toggle" />
      <div className="arc-auth">
        <form className="arc-auth__card" onSubmit={submit}>
          <ArcLogo size={52} />
          <h1>Arc Studio</h1>
          <p className="arc-sub">This instance is protected. Enter the access token to continue.</p>
          <input
            className="arc-input"
            type="password"
            value={token}
            autoFocus
            placeholder="Access token"
            onChange={(e) => setToken(e.target.value)}
          />
          <button className="arc-btn arc-btn--primary arc-btn--lg" type="submit" disabled={busy || !token.trim()}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
