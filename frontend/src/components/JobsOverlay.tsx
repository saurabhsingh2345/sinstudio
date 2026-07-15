import { useJobs } from "../jobs";

const label: Record<string, string> = {
  generate: "Generating clip",
  export: "Exporting video",
  transcribe: "Transcribing",
  import: "Importing",
};

export function JobsOverlay() {
  const { jobs, dismiss, cancel } = useJobs();
  const list = Object.values(jobs);
  if (list.length === 0) return null;
  return (
    <div className="jobs legacy">
      {list.map((j) => {
        const terminal = j.status === "done" || j.status === "error" || j.status === "canceled";
        const bad = j.status === "error" || j.status === "canceled";
        return (
        <div key={j.id} className={`job ${bad ? "err" : ""}`}>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <strong style={{ fontSize: 12 }}>{label[j.kind] || j.kind}</strong>
            <span className="small">{Math.round(j.progress * 100)}%</span>
            <div style={{ flex: 1 }} />
            {!terminal && (
              <a onClick={() => cancel(j.id)} style={{ cursor: "pointer", color: "var(--dim)" }} title="Cancel">
                Cancel
              </a>
            )}
            {terminal && (
              <a onClick={() => dismiss(j.id)} style={{ cursor: "pointer", color: "var(--dim)" }}>
                ✕
              </a>
            )}
          </div>
          <div className="small" style={{ color: bad ? "var(--danger)" : "var(--dim)" }}>
            {j.status === "done" ? "Done" : j.message || j.status}
          </div>
          <div className="bar">
            <div style={{ width: `${Math.round(j.progress * 100)}%`, background: j.status === "error" ? "var(--danger)" : undefined }} />
          </div>
          {j.log.length > 0 && !terminal && (
            <div className="log">{j.log.slice(-6).join("\n")}</div>
          )}
        </div>
        );
      })}
    </div>
  );
}
