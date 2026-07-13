import { useState } from "react";
import { api } from "../api";
import { awaitJob, useJobs } from "../jobs";
import { toast } from "../toast";
import { useStudio, projectDuration } from "../state";
import type { ExportOptions } from "../types";

const PRESETS: { value: ExportOptions["preset"]; label: string }[] = [
  { value: "", label: "Source (timeline size)" },
  { value: "shorts", label: "Shorts / Reels — 1080×1920" },
  { value: "square", label: "Square — 1080×1080" },
  { value: "4k", label: "4K — 3840×2160" },
  { value: "portrait4k", label: "4K Portrait — 2160×3840" },
];

const FORMATS: { value: ExportOptions["format"]; label: string }[] = [
  { value: "", label: "MP4 (H.264)" },
  { value: "webm", label: "WebM (VP9)" },
  { value: "gif", label: "Animated GIF" },
  { value: "mov", label: "MOV (ProRes)" },
];

export function ExportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { doc, playhead } = useStudio();
  const total = projectDuration(doc);
  const [preset, setPreset] = useState<ExportOptions["preset"]>("");
  const [format, setFormat] = useState<ExportOptions["format"]>("");
  const [useRange, setUseRange] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(+total.toFixed(2));
  const [loudnorm, setLoudnorm] = useState(true);
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [frameUrl, setFrameUrl] = useState<string>("");
  const [framing, setFraming] = useState(false);
  const progress = useJobs((s) => (jobId ? s.jobs[jobId]?.progress ?? 0 : 0));

  // Render the exact export frame at the playhead — ground truth vs. the preview.
  const previewFrame = async () => {
    setFraming(true);
    try {
      const { url } = await api.renderFrame(projectId, +playhead.toFixed(3), preset || undefined);
      setFrameUrl(url);
    } catch (e) {
      toast.error("Frame render failed: " + (e as Error).message);
    } finally {
      setFraming(false);
    }
  };

  const run = async () => {
    setBusy(true);
    try {
      const opts: ExportOptions = { preset, format, loudnorm };
      if (useRange) {
        opts.from = from;
        opts.to = to;
      }
      const { jobId: id } = await api.exportVideo(projectId, opts);
      setJobId(id);
      toast.info("Export started…");
      const data = await awaitJob(id);
      toast.success("Export ready");
      if (data?.url) window.open(data.url, "_blank");
      onClose();
    } catch (e) {
      toast.error("Export failed: " + (e as Error).message);
      setBusy(false);
      setJobId(null);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 440 }} onClick={(e) => e.stopPropagation()}>
        <h3>Export video</h3>

        <label>Aspect / resolution</label>
        <select value={preset} onChange={(e) => setPreset(e.target.value as any)}>
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>

        <label>Format</label>
        <select value={format} onChange={(e) => setFormat(e.target.value as any)}>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 12 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={useRange}
            onChange={(e) => setUseRange(e.target.checked)}
          />
          Export a time range only
        </label>

        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 8 }}>
          <input
            type="checkbox"
            style={{ width: "auto" }}
            checked={loudnorm}
            onChange={(e) => setLoudnorm(e.target.checked)}
          />
          Normalize loudness (EBU R128, −16 LUFS)
        </label>
        {useRange && (
          <div className="row">
            <div>
              <label>From (s)</label>
              <input type="number" step={0.1} value={from} onChange={(e) => setFrom(+e.target.value)} />
            </div>
            <div>
              <label>To (s)</label>
              <input type="number" step={0.1} value={to} onChange={(e) => setTo(+e.target.value)} />
            </div>
          </div>
        )}

        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button style={{ flex: "0 0 auto" }} disabled={framing} onClick={previewFrame}>
              {framing ? "Rendering…" : `⧉ Render frame @ ${playhead.toFixed(2)}s`}
            </button>
            <span className="small">exact export frame — verify vs. the canvas preview</span>
          </div>
          {frameUrl && (
            <img
              src={frameUrl}
              alt="exact export frame"
              style={{ width: "100%", marginTop: 10, borderRadius: 6, border: "1px solid var(--line)", display: "block" }}
            />
          )}
        </div>

        {busy && (
          <div className="job" style={{ marginTop: 12 }}>
            <div className="small">Exporting… {Math.round(progress * 100)}%</div>
            <div className="bar">
              <div style={{ width: `${Math.max(2, progress * 100)}%` }} />
            </div>
          </div>
        )}

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button style={{ flex: "0 0 auto" }} onClick={onClose} disabled={busy}>
            {busy ? "Close" : "Cancel"}
          </button>
          <button className="primary" style={{ flex: "0 0 auto" }} disabled={busy} onClick={run}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
