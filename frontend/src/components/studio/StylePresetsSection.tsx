import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyStylePreset } from "../../applyStylePreset";
import { useStudio } from "../../state";
import { toast } from "../../toast";
import type { Asset, Clip } from "../../types";
import { STYLE_PRESETS, type StylePreset } from "../../stylePresets";
import { Section } from "./inspector-bits";

export function StylePresetsSection({
  trackId,
  clip,
  asset,
}: {
  trackId: string;
  clip: Clip;
  asset: Asset;
}) {
  const projectId = useStudio((s) => s.doc?.id ?? "");
  const canvas = useStudio((s) => s.doc?.canvas);
  const updateClip = useStudio((s) => s.updateClip);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = async (preset: StylePreset) => {
    if (!canvas || !projectId) return;
    setBusy(preset.id);
    try {
      const result = await applyStylePreset(projectId, trackId, clip, asset, preset, canvas, updateClip);
      const parts = result.applied.join(", ") || "look";
      toast.success(`${preset.name} applied (${parts}${result.zooms ? ` · ${result.zooms} zoom${result.zooms > 1 ? "s" : ""}` : ""})`);
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  if (asset.kind === "audio") return null;

  return (
    <Section label="Style presets" defaultOpen>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        One-click backdrop, cursor polish{asset.hasCursor ? ", and auto-zoom" : ""}. Undo restores the previous look.
      </div>
      <div className="grid grid-cols-2 gap-1.5 pt-1">
        {STYLE_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            disabled={!!busy}
            onClick={() => void apply(p)}
            className="flex flex-col gap-1 rounded-lg border hairline bg-panel-2 p-2 text-left transition-colors hover:border-brand/40 hover:bg-panel-3 disabled:opacity-50"
          >
            <span className="h-6 w-full rounded-md" style={{ background: p.swatch }} />
            <span className="text-[11px] font-medium leading-tight">{p.name}</span>
            <span className="text-[9px] leading-snug text-muted-foreground">{p.description}</span>
            {busy === p.id && <span className="text-[9px] text-brand">Applying…</span>}
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Compact preset row for post-recording checklist. */
export function StylePresetQuickPick({
  trackId,
  clipId,
  assetId,
  onApplied,
}: {
  trackId: string;
  clipId: string;
  assetId: string;
  onApplied?: () => void;
}) {
  const doc = useStudio((s) => s.doc);
  const updateClip = useStudio((s) => s.updateClip);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = async (preset: StylePreset) => {
    if (!doc) return;
    const track = doc.tracks.find((t) => t.id === trackId);
    const clip = track?.clips?.find((c) => c.id === clipId);
    const asset = doc.assets.find((a) => a.id === assetId);
    if (!clip || !asset) {
      toast.error("Clip not found — open the timeline and try from the inspector.");
      return;
    }
    setBusy(preset.id);
    try {
      await applyStylePreset(doc.id, trackId, clip, asset, preset, doc.canvas, updateClip);
      toast.success(`${preset.name} applied`);
      onApplied?.();
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        <Sparkles className="h-3 w-3" /> Pick a style
      </div>
      <div className="grid grid-cols-3 gap-1">
        {STYLE_PRESETS.slice(0, 3).map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant="secondary"
            disabled={!!busy}
            className="h-auto flex-col gap-0.5 py-1.5 text-[10px]"
            onClick={() => void apply(p)}
          >
            <span className="h-3 w-full rounded-sm" style={{ background: p.swatch }} />
            {p.name}
          </Button>
        ))}
      </div>
    </div>
  );
}
