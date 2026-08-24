import { useRef } from "react";
import { Crop as CropIcon, Frame, Maximize2, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { cropPixels, cropToAspect, fitMode, isEmptyCrop, sourceSize } from "../../crop";
import { barsAgainst, canvasForClip } from "../../matchCanvas";
import { applyCanvas } from "../../setCanvas";
import type { Asset, Clip, Crop, FitMode } from "../../types";
import { isCameraClip } from "../../virtualCamera";
import { toast } from "../../toast";
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
  const mutate = useStudio((s) => s.mutate);

  const canvas = doc?.canvas;
  const cropped = sourceSize(asset, clip);
  const px = cropPixels(clip.crop, asset.width, asset.height);
  const camera = isCameraClip(clip, asset);
  const mode = fitMode(clip.fit);
  const cropping = croppingClip === clip.id;

  // Does this clip letterbox as things stand? The one question the panel exists
  // to answer, and the reason the Fill button is offered when it does.
  const canvasA = canvas ? canvas.width / canvas.height : 0;
  const croppedA = cropped ? cropped.width / cropped.height : 0;
  const barred =
    mode === "fit" && canvasA > 0 && croppedA > 0 && Math.abs(croppedA - canvasA) / canvasA > 0.005;

  /*
   * Which way it is barred, and the canvas that would end it.
   *
   * Named directions rather than a boolean because "black down both sides" and
   * "black above and below" are what a person actually sees — a panel that says
   * "bars" leaves them working out which, and the two have different causes.
   */
  const bars = barsAgainst(asset, clip, canvas);
  const matchTo = canvas ? canvasForClip(asset, clip, canvas.fps) : null;

  const matchCanvas = async () => {
    if (!doc || !matchTo) return;
    const summary = await applyCanvas(doc, matchTo, mutate, { matchedClipId: clip.id });
    toast.success(
      `Canvas is now ${matchTo.width}×${matchTo.height}${summary ? ` — ${summary}` : ""}`
    );
  };

  /*
   * Which axis actually overflows when this clip fills.
   *
   * Filling scales the picture until it covers the frame, so exactly one axis
   * spills over — the other is flush. Only the spilling one is worth dragging,
   * and offering both would imply a freedom that does not exist.
   */
  const overflow =
    croppedA > 0 && canvasA > 0 && Math.abs(croppedA - canvasA) / canvasA > 0.005
      ? { x: croppedA > canvasA, y: croppedA < canvasA }
      : null;

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
        A filled clip throws away whatever does not fit, and which part it
        throws away is a choice. Shown only when the clip really does overflow —
        a picture already the canvas's shape has nothing to choose between, and
        a control that does nothing is worse than no control.
      */}
      {mode !== "fit" && overflow && (
        <FillFocusPad
          overflowX={overflow.x}
          overflowY={overflow.y}
          x={clip.fillFocusX ?? 0}
          y={clip.fillFocusY ?? 0}
          onChange={(x, y) => updateClip(trackId, clip.id, { fillFocusX: x, fillFocusY: y })}
        />
      )}

      {/*
        The other half of "cut the top off": what is left is a different shape,
        so it bars, and the clip that filled the frame a moment ago now sits in
        black. Offered only when that is actually happening.

        BOTH answers, with their costs named. Fill was the only offer here, so it
        read as the only answer — and Fill crops. For a picture that is already
        framed the way its author wants, every fit is wrong and the fix is to
        reshape the CANVAS, which costs nothing and loses nothing. That option
        existed nowhere in the app.
      */}
      {barred && (
        <div className="space-y-1.5 rounded-md border hairline bg-panel-3/60 p-2">
          <p className="text-[10px] leading-snug text-muted-foreground">
            Black {bars === "sides" ? "down both sides" : "above and below"} — the picture is{" "}
            {bars === "sides" ? "narrower" : "wider"} than the {canvas?.width}×{canvas?.height} canvas.
          </p>
          {matchTo && (
            <Button size="sm" className="h-7 w-full text-xs" onClick={() => void matchCanvas()}>
              <Frame className="mr-1.5 h-3 w-3" />
              Match canvas to this clip ({matchTo.width}×{matchTo.height})
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-full bg-panel-2 text-xs"
            onClick={() => updateClip(trackId, clip.id, { fit: "fill" })}
          >
            <Maximize2 className="mr-1.5 h-3 w-3" />
            Fill the frame — crops the {bars === "sides" ? "top and bottom" : "sides"}
          </Button>
          <p className="text-[10px] leading-snug text-muted-foreground">
            Matching keeps every pixel and changes the project's shape. Filling keeps the shape and
            throws the overflow away.
          </p>
        </div>
      )}
    </Section>
  );
}

/*
Choosing which part of an overflowing picture survives.

A slider per axis would be simpler and would lie: filling scales the picture
until it covers the frame, so only one axis ever spills, and a control offering
two implies a freedom that is not there. This offers exactly the axis that
moved, as a track you drag along — the same gesture as dragging the picture
itself, which is what this stands in for until the stage learns the gesture.

Values are centre-relative (±0.5 an edge) so the zero value is the centred crop
the clip already had, and the reset is a single assignment.
*/
function FillFocusPad({
  overflowX,
  overflowY,
  x,
  y,
  onChange,
}: {
  overflowX: boolean;
  overflowY: boolean;
  x: number;
  y: number;
  onChange: (x: number, y: number) => void;
}) {
  const horizontal = overflowX;
  const value = horizontal ? x : y;
  const set = (v: number) => {
    const c = Math.max(-0.5, Math.min(0.5, v));
    onChange(horizontal ? c : 0, horizontal ? 0 : c);
  };
  const ref = useRef<HTMLDivElement>(null);

  // Pointer capture, so a drag that leaves the track keeps working — letting go
  // of the picture the moment the cursor slips off it is the thing that makes a
  // drag feel broken.
  const drag = (e: React.PointerEvent) => {
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const along = horizontal ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height;
      set(Math.max(0, Math.min(1, along)) - 0.5);
    };
    move(e.nativeEvent);
    const up = () => {
      el.releasePointerCapture(e.pointerId);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
  };

  const pct = (value + 0.5) * 100;
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {horizontal ? "What stays in frame — left ↔ right" : "What stays in frame — top ↕ bottom"}
        </span>
        {value !== 0 && (
          <button
            type="button"
            onClick={() => onChange(0, 0)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <RotateCcw className="h-3 w-3" /> Centre
          </button>
        )}
      </div>
      <div
        ref={ref}
        onPointerDown={drag}
        className="relative h-7 cursor-ew-resize touch-none rounded-md border hairline bg-panel-3"
        style={{ cursor: horizontal ? "ew-resize" : "ns-resize" }}
      >
        {/* The window on the picture: the part that survives. */}
        <div
          className="absolute rounded-sm bg-brand/30 ring-1 ring-brand"
          style={
            horizontal
              ? { top: 2, bottom: 2, width: "34%", left: `calc(${pct}% - 17%)` }
              : { left: 2, right: 2, height: "34%", top: `calc(${pct}% - 17%)` }
          }
        />
      </div>
    </div>
  );
}
