import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { applyStylePreset } from "../../applyStylePreset";
import { useStudio } from "../../state";
import { toast } from "../../toast";
import type { Asset, Clip } from "../../types";
import { STYLE_PRESETS, type StylePreset } from "../../stylePresets";
import {
  BACKDROP_DEFAULTS,
  backdropShown,
  backdropStored,
} from "../../backdrop";
import { Section, SliderRow } from "./inspector-bits";
import type { Backdrop } from "../../types";

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

  const bd = clip.backdrop;
  const patchBackdrop = (p: Partial<Backdrop>) =>
    updateClip(trackId, clip.id, { backdrop: { ...(bd ?? {}), ...p } });

  /*
   * Collapsed by default, and it stays where you put it (Section remembers).
   *
   * Five two-column cards carrying a swatch, a name AND a description made this
   * the tallest panel in the inspector, permanently open, for a control you use
   * once per clip. One line each, description in the tooltip.
   */
  return (
    <Section label="Style presets" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        One-click backdrop, cursor polish{asset.hasCursor ? ", and auto-zoom" : ""}. Undo restores the
        previous look.
      </div>
      <div className="space-y-1 pt-0.5">
        {STYLE_PRESETS.map((p) => {
          // The space it will take, stated on the card. A preset's padding is
          // what actually shrinks the picture, and nothing here used to say so —
          // the control lived in a different section entirely.
          const pad = p.clears
            ? "none"
            : `${Math.round(backdropShown(p.backdrop?.inset, BACKDROP_DEFAULTS.inset) * 100)}%`;
          return (
            <button
              key={p.id}
              type="button"
              disabled={!!busy}
              title={p.description}
              onClick={() => void apply(p)}
              className="flex w-full items-center gap-2 rounded-md border hairline bg-panel-2 px-1.5 py-1 text-left transition-colors hover:border-brand/40 hover:bg-panel-3 disabled:opacity-50"
            >
              <span className="h-4 w-6 shrink-0 rounded" style={{ background: p.swatch }} />
              <span className="flex-1 truncate text-[11px] font-medium leading-tight">{p.name}</span>
              <span className="tabular shrink-0 text-[9px] text-muted-foreground">
                {busy === p.id ? "applying…" : `pad ${pad}`}
              </span>
            </button>
          );
        })}
      </div>

      {/*
        The space, adjustable where it was chosen.

        A preset's padding is the thing people want to change straight after
        applying one, and it used to mean finding the Backdrop section further
        down the inspector and working out that "Padding" was the same number.
        All three reach a true zero now — see backdropStored.
      */}
      {bd && (
        <div className="space-y-2 border-t hairline pt-2">
          <div className="label-caps">Space it takes</div>
          <SliderRow
            label="Padding"
            value={Math.round(backdropShown(bd.inset, BACKDROP_DEFAULTS.inset) * 100)}
            min={0}
            max={35}
            step={1}
            onChange={(v) => patchBackdrop({ inset: backdropStored(v / 100) })}
            fmt={(v) => (v === 0 ? "none" : `${v}%`)}
          />
          <SliderRow
            label="Corners"
            value={Math.round(backdropShown(bd.radius, BACKDROP_DEFAULTS.radius))}
            min={0}
            max={60}
            step={2}
            onChange={(v) => patchBackdrop({ radius: backdropStored(v) })}
            fmt={(v) => (v === 0 ? "square" : `${v}px`)}
          />
          <SliderRow
            label="Shadow"
            value={Math.round(backdropShown(bd.shadow, BACKDROP_DEFAULTS.shadow) * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(v) => patchBackdrop({ shadow: backdropStored(v / 100) })}
            fmt={(v) => (v === 0 ? "none" : `${v}%`)}
          />
          <button
            type="button"
            onClick={() => updateClip(trackId, clip.id, { backdrop: undefined })}
            className="w-full rounded-md bg-panel-3 py-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            Remove the frame entirely
          </button>
        </div>
      )}
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
        {/* Looks only: "No frame" is a way back, not a first choice. */}
        {STYLE_PRESETS.filter((p) => !p.clears)
          .slice(0, 3)
          .map((p) => (
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
