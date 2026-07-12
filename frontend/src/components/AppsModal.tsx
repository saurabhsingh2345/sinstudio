import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { AppStatus } from "../types";

// App id → the generator adapter id that produces clips from it. All three apps
// now have a headless generate path.
const GENERATOR_FOR: Record<string, string> = {
  newaniadv: "newaniadv",
  hyperframes: "hyperframes",
  funkycode: "funkycode",
};

const dotColor = (a: AppStatus) => {
  if (a.state === "running") return a.healthy ? "#3ddc84" : "#f4b740"; // green / booting
  if (a.state === "exited") return "#ff5c5c"; // crashed
  return "#6b7280"; // stopped
};

const stateLabel = (a: AppStatus) => {
  if (a.state === "running") return a.healthy ? `running · ${a.uptime}` : "booting…";
  if (a.state === "exited") return "crashed";
  return "stopped";
};

// AppsModal is Studio's control room: run/stop/restart the sibling apps, watch
// their logs, open them in a browser, and jump straight into live generation.
export function AppsModal({
  onClose,
  onGenerate,
}: {
  onClose: () => void;
  onGenerate: (generatorId: string) => void;
}) {
  const [list, setList] = useState<AppStatus[]>([]);
  const [busy, setBusy] = useState("");
  const [logsFor, setLogsFor] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  // Poll status while the modal is open.
  useEffect(() => {
    let alive = true;
    const tick = () => api.apps().then((a) => alive && setList(a)).catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Poll logs for the expanded app.
  useEffect(() => {
    if (!logsFor) return;
    let alive = true;
    const tick = () =>
      api.appLogs(logsFor).then((r) => alive && setLogs(r.lines)).catch(() => {});
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [logsFor]);

  // Keep the log view pinned to the bottom.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const act = async (id: string, fn: () => Promise<unknown>, label: string) => {
    setBusy(id + label);
    try {
      await fn();
    } catch (e) {
      toast.error(`${label} failed: ${(e as Error).message}`);
    } finally {
      setBusy("");
      api.apps().then(setList).catch(() => {});
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal-h">
          <b>Apps</b>
          <span className="muted">— run &amp; manage your generator products</span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="apps-grid">
          {list.map((a) => {
            const running = a.state === "running";
            const genId = GENERATOR_FOR[a.id];
            return (
              <div key={a.id} className="app-card">
                <div className="app-top">
                  <span className="dot" style={{ background: dotColor(a) }} />
                  <b>{a.name}</b>
                  <span className="muted">{stateLabel(a)}</span>
                  <div className="spacer" />
                  {a.url && (
                    <a
                      className={"linkbtn" + (running && a.healthy ? "" : " disabled")}
                      href={running && a.healthy ? a.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                      title={a.url}
                    >
                      Open ↗
                    </a>
                  )}
                </div>

                {a.description && <div className="app-desc muted">{a.description}</div>}

                <div className="app-actions">
                  {running ? (
                    <>
                      <button
                        disabled={!!busy}
                        onClick={() => act(a.id, () => api.stopApp(a.id), "stop")}
                      >
                        {busy === a.id + "stop" ? "…" : "Stop"}
                      </button>
                      <button
                        disabled={!!busy}
                        onClick={() => act(a.id, () => api.restartApp(a.id), "restart")}
                      >
                        {busy === a.id + "restart" ? "…" : "Restart"}
                      </button>
                    </>
                  ) : (
                    <button
                      className="primary"
                      disabled={!!busy}
                      onClick={() => act(a.id, () => api.startApp(a.id), "start")}
                    >
                      {busy === a.id + "start" ? "starting…" : "Start"}
                    </button>
                  )}

                  <button onClick={() => setLogsFor(logsFor === a.id ? "" : a.id)}>
                    {logsFor === a.id ? "Hide logs" : "Logs"}
                  </button>

                  {genId ? (
                    <button
                      className="ghost"
                      title="Generate a clip from this app and import it"
                      onClick={() => onGenerate(genId)}
                    >
                      Generate →
                    </button>
                  ) : (
                    <span className="muted" title="Headless generation is a later phase">
                      import-only
                    </span>
                  )}
                </div>

                {logsFor === a.id && (
                  <pre ref={logRef} className="app-logs">
                    {logs.length ? logs.join("\n") : "(no output yet)"}
                  </pre>
                )}
              </div>
            );
          })}
          {list.length === 0 && <div className="muted">No apps configured.</div>}
        </div>
      </div>
    </div>
  );
}
