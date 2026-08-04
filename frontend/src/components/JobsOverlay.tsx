import { useJobs } from "../jobs";

const label: Record<string, string> = {
  generate: "Generating clip",
  export: "Exporting video",
  transcribe: "Transcribing",
  import: "Importing",
};

// A quiet corner ticker: what's running and how far along, nothing more. The
// detail — logs, retries, past renders — lives in the render queue. Finished
// jobs drop out on their own; only failures stay put, so a problem is seen.
export function JobsOverlay() {
  const { jobs, dismiss, cancel } = useJobs();
  const list = Object.values(jobs).filter((j) => j.status !== "done");
  if (list.length === 0) return null;
  return (
    <div className="jobs legacy">
      {list.map((j) => {
        const bad = j.status === "error" || j.status === "canceled";
        const pct = Math.round(j.progress * 100);
        return (
          <div key={j.id} className={`job ${bad ? "err" : ""}`}>
            <div className="job-row">
              <span className="job-name">{label[j.kind] || j.kind}</span>
              <span className="job-pct">
                {bad ? (j.status === "canceled" ? "Canceled" : "Failed") : j.status === "queued" ? "Queued" : `${pct}%`}
              </span>
              <button
                className="job-x"
                onClick={() => (bad ? dismiss(j.id) : cancel(j.id))}
                title={bad ? "Dismiss" : "Cancel"}
              >
                ✕
              </button>
            </div>
            {bad ? (
              <div className="job-msg">{j.message || j.status}</div>
            ) : (
              <div className="bar">
                <div style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
