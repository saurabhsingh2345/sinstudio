import { useEffect, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import { useJobs } from "../jobs";
import type { RenderEntry } from "../types";

const fmtSize = (b: number) => (b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString();
};

// RendersModal shows the export queue (queued/running exports, from the live job
// stream) and the render history (finished files on disk) with download/delete
// and retry for failed exports.
export function RendersModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { jobs, cancel, retry, dismiss } = useJobs();
  const exportJobs = Object.values(jobs).filter((j) => j.kind === "export");
  const [renders, setRenders] = useState<RenderEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api
      .listRenders(projectId)
      .then((d) => setRenders(d.renders))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [projectId]);

  // Refresh the history whenever an export finishes.
  const doneCount = exportJobs.filter((j) => j.status === "done").length;
  useEffect(() => {
    if (doneCount) refresh();
  }, [doneCount]);

  const del = async (name: string) => {
    try {
      await api.deleteRender(projectId, name);
      setRenders((r) => r.filter((x) => x.name !== name));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const active = exportJobs.filter((j) => j.status === "queued" || j.status === "running");
  const failed = exportJobs.filter((j) => j.status === "error" || j.status === "canceled");

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 560, maxHeight: "80vh", overflow: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3>Render queue</h3>

        {active.length > 0 && (
          <div className="renders-group">
            {active.map((j) => (
              <div key={j.id} className="render-row">
                <span className="badge">{j.status === "queued" ? "Queued" : `Rendering ${Math.round(j.progress * 100)}%`}</span>
                <div className="bar" style={{ flex: 1 }}>
                  <div style={{ width: `${Math.max(3, j.progress * 100)}%` }} />
                </div>
                <button onClick={() => cancel(j.id)}>Cancel</button>
              </div>
            ))}
          </div>
        )}

        {failed.map((j) => (
          <div key={j.id} className="render-row err">
            <span className="badge err">{j.status === "canceled" ? "Canceled" : "Failed"}</span>
            <span className="small" style={{ flex: 1 }}>{j.message}</span>
            <button onClick={() => retry(j.id)}>Retry</button>
            <button onClick={() => dismiss(j.id)}>✕</button>
          </div>
        ))}

        <div className="kf-head" style={{ marginTop: 14 }}>
          History
          <div className="spacer" />
          <button className="ghost" onClick={refresh}>refresh</button>
        </div>

        {loading ? (
          <div className="small">Loading…</div>
        ) : renders.length === 0 ? (
          <div className="small">No exports yet. Use Export to render one.</div>
        ) : (
          renders.map((r) => (
            <div key={r.name} className="render-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                <div className="small">{fmtSize(r.size)} · {fmtWhen(r.created)}</div>
              </div>
              <a className="btn" href={r.url} target="_blank" rel="noreferrer">Download</a>
              <button onClick={() => del(r.name)}>Delete</button>
            </div>
          ))
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button style={{ flex: "0 0 auto" }} onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
