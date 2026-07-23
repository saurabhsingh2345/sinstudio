import { useState } from "react";
import { Image } from "lucide-react";
import { api } from "../api";
import { awaitJob, useJobs } from "../jobs";
import { toast } from "../toast";
import { useStudio, projectDuration } from "../state";
import type { ExportOptions } from "../types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModalField, ModalProgress, StudioModal } from "./studio/StudioModal";

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

const SOCIAL_EXPORTS: {
  id: string;
  label: string;
  sub: string;
  preset: ExportOptions["preset"];
  format: ExportOptions["format"];
}[] = [
  { id: "youtube", label: "YouTube", sub: "16:9 MP4", preset: "", format: "" },
  { id: "shorts", label: "Shorts", sub: "9:16 MP4", preset: "shorts", format: "" },
  { id: "linkedin", label: "LinkedIn", sub: "Square MP4", preset: "square", format: "" },
  { id: "twitter", label: "Twitter GIF", sub: "Square GIF", preset: "square", format: "gif" },
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

  const run = async (overrides?: Partial<ExportOptions>) => {
    setBusy(true);
    try {
      const p = overrides?.preset ?? preset;
      const f = overrides?.format ?? format;
      const ln = overrides?.loudnorm ?? loudnorm;
      const opts: ExportOptions = { preset: p, format: f, loudnorm: ln };
      if (useRange) {
        opts.from = from;
        opts.to = to;
      }
      const { jobId: id } = await api.exportVideo(projectId, opts);
      setJobId(id);
      toast.info("Export started…");
      const data = await awaitJob(id);
      toast.success("Export ready");
      if (data?.url) {
        const abs = String(data.url).startsWith("http") ? String(data.url) : `${window.location.origin}${data.url}`;
        try {
          await navigator.clipboard.writeText(abs);
          toast.info("Share link copied — paste to share the render");
        } catch {
          window.open(data.url, "_blank");
        }
      }
      onClose();
    } catch (e) {
      toast.error("Export failed: " + (e as Error).message);
      setBusy(false);
      setJobId(null);
    }
  };

  return (
    <StudioModal
      title="Export video"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {busy ? "Close" : "Cancel"}
          </Button>
          <Button onClick={() => void run()} disabled={busy}>
            {busy ? "Exporting…" : "Export"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Quick export</p>
          <div className="grid grid-cols-2 gap-2">
            {SOCIAL_EXPORTS.map((s) => (
              <button
                key={s.id}
                type="button"
                disabled={busy}
                onClick={() => void run({ preset: s.preset, format: s.format, loudnorm: true })}
                className="rounded-lg border hairline bg-panel-2 px-3 py-2 text-left transition-colors hover:border-brand/40 hover:bg-panel-3 disabled:opacity-50"
              >
                <span className="block text-[13px] font-medium">{s.label}</span>
                <span className="block text-[10px] text-muted-foreground">{s.sub}</span>
              </button>
            ))}
          </div>
        </div>

        <ModalField label="Aspect / resolution">
          <Select
            value={preset || "_source"}
            onValueChange={(v) => setPreset(v === "_source" ? "" : (v as ExportOptions["preset"]))}
          >
            <SelectTrigger className="h-9 bg-panel-2 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRESETS.map((p) => (
                <SelectItem key={p.value || "_source"} value={p.value || "_source"}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ModalField>

        <ModalField label="Format">
          <Select value={format || "_mp4"} onValueChange={(v) => setFormat(v === "_mp4" ? "" : (v as ExportOptions["format"]))}>
            <SelectTrigger className="h-9 bg-panel-2 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => (
                <SelectItem key={f.value || "_mp4"} value={f.value || "_mp4"}>
                  {f.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ModalField>

        <div className="space-y-3 rounded-lg bg-panel-2 p-3">
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[13px]">Export a time range only</span>
            <Switch checked={useRange} onCheckedChange={setUseRange} />
          </label>
          <label className="flex cursor-pointer items-center justify-between gap-3">
            <span className="text-[13px]">Normalize loudness (EBU R128, −16 LUFS)</span>
            <Switch checked={loudnorm} onCheckedChange={setLoudnorm} />
          </label>
        </div>

        {useRange && (
          <div className="grid grid-cols-2 gap-3">
            <ModalField label="From (s)">
              <Input type="number" step={0.1} value={from} onChange={(e) => setFrom(+e.target.value)} className="h-9 bg-panel-2" />
            </ModalField>
            <ModalField label="To (s)">
              <Input type="number" step={0.1} value={to} onChange={(e) => setTo(+e.target.value)} className="h-9 bg-panel-2" />
            </ModalField>
          </div>
        )}

        <div className="space-y-3 border-t hairline pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[12px] font-medium">Export fidelity check</p>
              <p className="text-[10px] text-muted-foreground">
                Renders the exact export frame at the playhead — compare to the canvas preview above the timeline.
                LUT grades and motion blur match export; CSS preview is approximate for those.
              </p>
            </div>
            <Button variant="secondary" size="sm" disabled={framing} onClick={previewFrame}>
              <Image className="mr-1.5 h-3.5 w-3.5" />
              {framing ? "Rendering…" : `@ ${playhead.toFixed(2)}s`}
            </Button>
          </div>
          {frameUrl && (
            <div className="space-y-1">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Authoritative export frame</p>
              <img src={frameUrl} alt="Exact export frame" className="w-full rounded-lg border hairline" />
            </div>
          )}
        </div>

        {busy && <ModalProgress label="Exporting…" progress={progress} />}
      </div>
    </StudioModal>
  );
}
