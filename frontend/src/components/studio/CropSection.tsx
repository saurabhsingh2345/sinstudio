import { Crop as CropIcon, Maximize2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { cropPixels, cropToAspect, fitMode, isEmptyCrop, sourceSize } from "../../crop";
import type { Asset, Clip, Crop, FitMode } from "../../types";
import { isCameraClip } from "../../virtualCamera";
import { Field, NumInput, Section } from "./inspector-bits";

/*
 * Crop & Fit — cut the edges off a clip, then decide how what's left meets the
 * canvas.
 *
 * The two belong in one panel because they are one thought. Trimming the menu
 * bar off a screen recording leaves a picture that is no longer the canvas's
 * shape, so it letterboxes — and the recording that was flush with the frame a
 * moment ago now sits in bars, which reads as the crop having broken something.
 * Fill is the other half of the sentence, and it is one click away rather than
 * a scale value you are left to work out.
 */

const EDGES: { key: keyof Crop; label: string }[] = [
  { key: "top", label: "Top" },
  { key: "bottom", label: "Bottom" },
  { key: "left", label: "Left" },
  { key: "right", label: "Right" },
];

const FITS: { key: FitMode; label: string; hint: string }[] = [
  { key: "", label: "Auto", hint: "Letterbox, or fill when the camera is working this clip." },
  { key: "fit", label: "Fit", hint: "Show all of it, with transparent bars where the shapes differ." },
  { key: "fill", label: "Fill", hint: "Cover the frame. Anything past the edge is not shown." },
  { key: "stretch", label: "Stretch", hint: "Distort to fill. Rarely what you want, occasionally exactly it." },
];

export function CropSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const updateClip = useStudio((s) => s.updateClip);
  const croppingClip = useStudio((s) => s.croppingClip);
  const setCroppingClip = useStudio((s) => s.setCroppingClip);
  const doc = useStudio((s) => s.doc);

  const canvas = doc?.canvas;
  const cropped = sourceSize(asset, clip);
  const px = cropPixels(clip.crop, asset.width, asset.height);
  const camera = isCameraClip(clip, asset);
  const mode = fitMode(clip.fit, camera);
  const cropping = croppingClip === clip.id;

  // Does this clip letterbox as things stand? The one question the panel exists
  // to answer, and the reason the Fill button is offered when it does.
  const canvasA = canvas ? canvas.width / canvas.height : 0;
  const croppedA = cropped ? cropped.width / cropped.height : 0;
  const barred =
    mode === "fit" && canvasA > 0 && croppedA > 0 && Math.abs(croppedA - canvasA) / canvasA > 0.005;

  const setCrop = (c: Crop) => updateClip(trackId, clip.id, { crop: isEmptyCrop(c) ? undefined : c });
  const setEdge = (key: keyof Crop, pct: number) =>
    setCrop({ ...clip.crop, [key]: Math.max(0, Math.min(0.9, pct / 100)) });

  return (
    <Section label="Crop & fit" defaultOpen={!isEmptyCrop(clip.crop) || !!clip.fit}>
      <Button
        size="sm"
        variant={cropping ? "default" : "ghost"}
        className={cn("h-7 w-full text-xs", !cropping && "bg-panel-3")}
        onClick={() => setCroppingClip(cropping ? null : clip.id)}
      >
        <CropIcon className="mr-1.5 h-3 w-3" />
        {cropping ? "Done cropping" : "Crop on canvas"}
      </Button>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Drag the edges of the picture. The dimmed part is what gets cut.
      </p>

      <div className="grid grid-cols-2 gap-2">
        {EDGES.map((e) => (
          <Field key={e.key} label={e.label}>
            <NumInput
              value={Math.round(((clip.crop?.[e.key] ?? 0) as number) * 1000) / 10}
              min={0}
              max={90}
              step={1}
              suffix="%"
              onChange={(v) => setEdge(e.key, v)}
            />
          </Field>
        ))}
      </div>

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          Picture is <span className="tabular text-foreground">{px.w}×{px.h}</span>
          {asset.width > 0 && (px.w !== asset.width || px.h !== asset.height) && (
            <span className="tabular"> of {asset.width}×{asset.height}</span>
          )}
        </span>
        {!isEmptyCrop(clip.crop) && (
          <button
            type="button"
            onClick={() => setCrop({})}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        )}
      </div>

      {canvas && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full bg-panel-3 text-xs"
          onClick={() => setCrop(cropToAspect({ width: asset.width, height: asset.height }, canvas.width / canvas.height))}
        >
          Crop to canvas shape ({canvas.width}×{canvas.height})
        </Button>
      )}

      <div className="space-y-1 pt-0.5">
        <div className="flex gap-1 rounded-md bg-panel-3 p-0.5">
          {FITS.map((f) => (
            <button
              key={f.key || "auto"}
              type="button"
              onClick={() => updateClip(trackId, clip.id, { fit: f.key || undefined })}
              className={cn(
                "flex-1 rounded px-1 py-1 text-[11px] font-medium transition-colors",
                (clip.fit ?? "") === f.key
                  ? "bg-brand text-brand-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
        <p className="px-0.5 text-[10px] leading-snug text-muted-foreground">
          {FITS.find((f) => f.key === (clip.fit ?? ""))?.hint}
        </p>
      </div>

      {/*
        The other half of "cut the top off": what is left is a different shape,
        so it letterboxes, and the clip that filled the frame a moment ago now
        sits in bars. Offered only when that is actually happening.
      */}
      {barred && (
        <Button
          size="sm"
          className="h-7 w-full text-xs"
          onClick={() => updateClip(trackId, clip.id, { fit: "fill" })}
        >
          <Maximize2 className="mr-1.5 h-3 w-3" />
          Fill the frame — no bars
        </Button>
      )}
    </Section>
  );
}
