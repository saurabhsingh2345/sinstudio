import { useState } from "react";
import { api } from "../api";
import { awaitJob } from "../jobs";
import { toast } from "../toast";
import { useStudio, projectDuration } from "../state";
import type { ExportOptions } from "../types";

const PRESETS: { value: ExportOptions["preset"]; label: string }[] = [
  { value: "", label: "Source (timeline size)" },
  { value: "shorts", label: "Shorts / Reels — 1080×1920" },
  { value: "square", label: "Square — 1080×1080" },
  { value: "4k", label: "4K — 3840×2160" },
];

const FORMATS: { value: ExportOptions["format"]; label: string }[] = [
  { value: "", label: "MP4 (H.264)" },
  { value: "webm", label: "WebM (VP9)" },
  { value: "gif", label: "Animated GIF" },
  { value: "mov", label: "MOV (ProRes)" },
];

export function ExportDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { doc } = useStudio();
  const total = projectDuration(doc);
  const [preset, setPreset] = useState<ExportOptions["preset"]>("");
  const [format, setFormat] = useState<ExportOptions["format"]>("");
  const [useRange, setUseRange] = useState(false);
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(+total.toFixed(2));
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const opts: ExportOptions = { preset, format };
      if (useRange) {
        opts.from = from;
        opts.to = to;
      }
      const { jobId } = await api.exportVideo(projectId, opts);
      toast.info("Export started…");
      onClose();
      const data = await awaitJob(jobId);
      toast.success("Export ready");
      if (data?.url) window.open(data.url, "_blank");
    } catch (e) {
      toast.error("Export failed: " + (e as Error).message);
      setBusy(false);
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

        <div className="row" style={{ marginTop: 16, justifyContent: "flex-end" }}>
          <button style={{ flex: "0 0 auto" }} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" style={{ flex: "0 0 auto" }} disabled={busy} onClick={run}>
            {busy ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
