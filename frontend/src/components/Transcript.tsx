import { useState } from "react";
import { useStudio } from "../state";
import { api } from "../api";
import { awaitJob } from "../jobs";
import { toast } from "../toast";
import type { CaptionCue } from "../types";

export function Transcript({ projectId }: { projectId: string }) {
  const { doc, setCues, addCue, updateCue, removeCue, selectCue } = useStudio();
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);

  if (!doc) return null;
  const cues = doc.tracks.find((t) => t.kind === "caption")?.cues || [];
  const audible = doc.assets.filter((a) => a.kind !== "image");

  const transcribe = async () => {
    const id = assetId || audible[0]?.id;
    if (!id) return;
    setBusy(true);
    try {
      const { jobId } = await api.transcribe(projectId, id);
      const data = await awaitJob(jobId);
      const newCues = (data?.cues as CaptionCue[] | undefined) ?? null;
      if (!newCues) {
        // Completion recovered via poll — the cue payload only rides the SSE
        // "done" event, so it's unavailable here. Ask the user to retry.
        toast.error("Transcription finished but the result was lost (connection blip) — try again.");
        return;
      }
      const merged = [...cues, ...newCues].sort((a, b) => a.start - b.start);
      setCues(merged);
      toast.success(`Added ${newCues.length} caption cues`);
    } catch (e) {
      toast.error("Transcription failed: " + (e as Error).message + " (set WHISPER_BIN / WHISPER_MODEL)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-h">
        Transcript
        <div className="spacer" />
        <button onClick={addCue}>+ Cue</button>
      </div>
      <div style={{ padding: 12 }}>
        <div className="row">
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">— pick audio/video —</option>
            {audible.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button style={{ flex: "0 0 auto" }} disabled={busy || audible.length === 0} onClick={transcribe}>
            {busy ? "…" : "Transcribe"}
          </button>
        </div>

        <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
          {cues.map((c) => (
            <div key={c.id} style={{ border: "1px solid var(--line)", borderRadius: 6, padding: 6 }}>
              <div className="small" style={{ display: "flex", gap: 6 }}>
                <span>{c.start.toFixed(1)}–{c.end.toFixed(1)}s</span>
                <div style={{ flex: 1 }} />
                <a onClick={() => selectCue(c.id)} style={{ cursor: "pointer", color: "var(--accent)" }}>
                  edit
                </a>
                <a onClick={() => removeCue(c.id)} style={{ cursor: "pointer", color: "var(--danger)" }}>
                  ✕
                </a>
              </div>
              <input value={c.text} onChange={(e) => updateCue(c.id, { text: e.target.value })} style={{ marginTop: 4 }} />
            </div>
          ))}
          {cues.length === 0 && <div className="muted small">No captions yet. Transcribe a clip or add cues.</div>}
        </div>
      </div>
    </>
  );
}
