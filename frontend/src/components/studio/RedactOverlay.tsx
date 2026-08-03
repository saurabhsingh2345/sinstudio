import { useEffect, useRef, useState } from "react";
import { Check, Trash2 } from "lucide-react";

import { cn } from "@/lib/utils";
import type { CropLayout } from "../../crop";
import {
  REDACT_KINDS,
  clampRedaction,
  isLiveAt,
  isTimed,
  previewBlurPx,
  redactionFromDrag,
  redactionRect,
  redactionWindow,
  sourceFraction,
} from "../../redaction";
import type { RedactKind, Redaction } from "../../types";

/*
 * Draw a blur over the thing that must not ship — an email, a password, a
 * licence key — on the picture itself.
 *
 * The regions are placed against `layout.media`, the whole uncropped source laid
 * out in the clip's box, because that is the space they are STORED in: the
 * renderer applies a redaction before the crop, so that trimming an edge can
 * never slide a blur off what it was hiding. Measuring against the visible box
 * instead would agree with the export right up until someone crops the clip.
 *
 * A rotated clip is un-rotated before any of that, so the numbers describe the
 * source rather than the screen.
 */

type Drag =
  | { kind: "new"; from: { x: number; y: number }; to: { x: number; y: number } }
  | { kind: "move" | "resize"; index: number };

export function RedactOverlay({
  regions,
  layout,
  box,
  sourceWidth,
  localTime,
  playDur,
  selected,
  onSelect,
  onBegin,
  onChange,
  onCommit,
  onDone,
}: {
  regions: Redaction[];
  layout: CropLayout;
  /** The clip's rectangle on the stage, and its rotation in degrees. */
  box: { left: number; top: number; vw: number; vh: number; rotation: number };
  sourceWidth: number;
  /** Where the playhead sits in the clip, and how long the clip plays — a region
   *  outside its own window is drawn as an outline rather than hidden, so it can
   *  still be selected and retimed. */
  localTime: number;
  playDur: number;
  selected: number;
  onSelect: (i: number) => void;
  onBegin: () => void;
  onChange: (next: Redaction[]) => void;
  onCommit: () => void;
  onDone: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const { window: win, media } = layout;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  /*
   * A client point in the clip's own unrotated box coordinates.
   *
   * The overlay element is rotated with the clip, so its bounding rect is the
   * rotated one and cannot be subtracted directly. Rotating the pointer back
   * about the box's centre is the only way the fractions describe the source.
   */
  const toBox = (clientX: number, clientY: number) => {
    const r = rootRef.current?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const a = (-box.rotation * Math.PI) / 180;
    const dx = clientX - cx;
    const dy = clientY - cy;
    // ...then into the crop window, which is the space `media` — and so every
    // region — is measured in. Under `fill` the window starts outside the box,
    // so these are genuinely different origins.
    return {
      x: box.vw / 2 + (dx * Math.cos(a) - dy * Math.sin(a)) - win.left,
      y: box.vh / 2 + (dx * Math.sin(a) + dy * Math.cos(a)) - win.top,
    };
  };

  // Every gesture is the same shape: open a transient, stream updates, commit.
  const gesture = (
    e: React.PointerEvent,
    onMove: (p: { x: number; y: number }, start: { x: number; y: number }) => void,
    onUp?: () => void
  ) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const start = toBox(e.clientX, e.clientY);
    onBegin();
    const move = (ev: PointerEvent) => onMove(toBox(ev.clientX, ev.clientY), start);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrag(null);
      onUp?.();
      onCommit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return start;
  };

  // Drawing a new region on empty picture.
  const startNew = (e: React.PointerEvent) => {
    const start = toBox(e.clientX, e.clientY);
    let last = start;
    gesture(
      e,
      (p) => {
        last = p;
        setDrag({ kind: "new", from: start, to: p });
      },
      () => {
        const r = redactionFromDrag(start, last, media);
        // A click with no drag means "put one here", not a one-pixel region.
        const tiny = Math.abs(last.x - start.x) < 4 && Math.abs(last.y - start.y) < 4;
        const next = tiny
          ? clampRedaction({ ...r, w: 0.18, h: 0.08, x: r.x - 0.09, y: r.y - 0.04 })
          : r;
        onChange([...regions, next]);
        onSelect(regions.length);
      }
    );
    setDrag({ kind: "new", from: start, to: start });
  };

  const startMove = (e: React.PointerEvent, i: number) => {
    onSelect(i);
    const origin = regions[i];
    gesture(e, (p, start) => {
      const d = sourceFraction(p.x, p.y, media);
      const s = sourceFraction(start.x, start.y, media);
      onChange(
        regions.map((r, k) =>
          k === i ? clampRedaction({ ...origin, x: origin.x + (d.x - s.x), y: origin.y + (d.y - s.y) }) : r
        )
      );
    });
    setDrag({ kind: "move", index: i });
  };

  const startResize = (e: React.PointerEvent, i: number) => {
    onSelect(i);
    const origin = regions[i];
    gesture(e, (p, start) => {
      const d = sourceFraction(p.x, p.y, media);
      const s = sourceFraction(start.x, start.y, media);
      onChange(
        regions.map((r, k) =>
          k === i ? clampRedaction({ ...origin, w: origin.w + (d.x - s.x), h: origin.h + (d.y - s.y) }) : r
        )
      );
    });
    setDrag({ kind: "resize", index: i });
  };

  // The live rectangle while a new one is being dragged out.
  const ghost =
    drag?.kind === "new" ? redactionRect(redactionFromDrag(drag.from, drag.to, media), media) : null;

  return (
    <div
      ref={rootRef}
      className="absolute z-10 select-none"
      style={{
        left: box.left,
        top: box.top,
        width: box.vw,
        height: box.vh,
        transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
        touchAction: "none",
      }}
    >
      {/* Only the surviving picture accepts a drag: a region drawn on a cropped
          edge would be stored against pixels the export has already thrown away. */}
      <div
        onPointerDown={startNew}
        className="absolute cursor-crosshair overflow-hidden ring-1 ring-brand/40"
        style={{ left: win.left, top: win.top, width: win.width, height: win.height }}
      >
        {regions.map((r, i) => {
          const rect = redactionRect(r, media);
          const blur = previewBlurPx(r.amount, media.width, sourceWidth);
          const isSel = i === selected;
          // A region whose window has passed is drawn as a dashed outline, not
          // hidden: it still has to be findable and retimable from a moment it
          // does not cover, and a region that vanished would look deleted.
          const live = isLiveAt(r, localTime, playDur);
          return (
            <div
              key={i}
              onPointerDown={(e) => startMove(e, i)}
              className={cn(
                "absolute cursor-move border-2",
                !live && "border-dashed",
                isSel ? "border-brand" : "border-white/60 hover:border-white"
              )}
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
                backdropFilter: live ? `blur(${blur}px)` : undefined,
                WebkitBackdropFilter: live ? `blur(${blur}px)` : undefined,
              }}
            >
              <span
                className={cn(
                  "absolute left-0 top-0 px-1 text-[9px] font-medium leading-4",
                  live ? "bg-brand text-brand-foreground" : "bg-panel/90 text-muted-foreground"
                )}
              >
                {i + 1}
                {!live && " · off"}
              </span>
              {isSel && (
                <span
                  onPointerDown={(e) => startResize(e, i)}
                  className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border-2 border-white bg-brand"
                />
              )}
            </div>
          );
        })}

        {ghost && (
          <div
            className="pointer-events-none absolute border-2 border-dashed border-brand bg-brand/20"
            style={{
              left: ghost.left,
              top: ghost.top,
              width: ghost.width,
              height: ghost.height,
            }}
          />
        )}
      </div>
    </div>
  );
}

/*
RedactToolbar — the region's properties, under the picture.

Below rather than over, for the same reason the crop bar is: the things worth
hiding sit in the picture, and a panel floating on top of them is a panel in the
way of the work.
*/
export function RedactToolbar({
  regions,
  selected,
  localTime,
  playDur,
  onSelect,
  onPatch,
  onRemove,
  onDone,
}: {
  regions: Redaction[];
  selected: number;
  /** The playhead's position in the clip, which is what "Starts here" and
   *  "Ends here" mean — retiming a blur is something you do while looking at the
   *  frame where the secret appears or goes away. */
  localTime: number;
  playDur: number;
  onSelect: (i: number) => void;
  onPatch: (p: Partial<Redaction>) => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  const r = regions[selected];
  const at = Math.max(0, Math.min(playDur, localTime));
  const win = r ? redactionWindow(r, playDur) : { from: 0, to: playDur };
  const bounded = r ? isTimed(r, playDur) : false;
  return (
    <div className="flex max-w-full flex-wrap items-center justify-center gap-x-2 gap-y-1 rounded-2xl border hairline bg-panel/95 px-3 py-1.5 text-[11px] shadow-lg backdrop-blur">
      <span className="font-medium">Blur</span>
      {regions.length === 0 ? (
        <span className="text-muted-foreground">Drag a box over what to hide</span>
      ) : (
        <>
          <div className="flex flex-wrap gap-0.5">
            {regions.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSelect(i)}
                className={cn(
                  "h-5 w-5 rounded text-[10px] font-medium",
                  i === selected ? "bg-brand text-brand-foreground" : "bg-panel-3 text-muted-foreground"
                )}
              >
                {i + 1}
              </button>
            ))}
          </div>

          <Divider />

          <div className="flex gap-0.5 rounded-md bg-panel-3 p-0.5">
            {REDACT_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                onClick={() => onPatch({ kind: k.kind as RedactKind })}
                className={cn(
                  "rounded px-1.5 py-0.5 font-medium transition-colors",
                  r?.kind === k.kind
                    ? "bg-brand text-brand-foreground"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {k.label}
              </button>
            ))}
          </div>

          <Divider />

          <label className="flex items-center gap-1.5 text-muted-foreground">
            Strength
            <input
              type="range"
              min={5}
              max={100}
              value={Math.round((r?.amount ?? 0.6) * 100)}
              onChange={(e) => onPatch({ amount: Number(e.target.value) / 100 })}
              className="h-1 w-20 accent-[var(--brand)]"
            />
            <span className="tabular w-7 text-right text-foreground">
              {Math.round((r?.amount ?? 0.6) * 100)}%
            </span>
          </label>

          <Divider />

          {/*
            When the blur is on. A secret usually appears and leaves — a password
            is typed and the field closes — and covering the whole clip for it
            smears a stretch of video with nothing to hide.

            Set from the playhead rather than typed: you are looking at the frame
            where the thing appears, and reading its timecode off the transport to
            type back in is work the button can do.
          */}
          <span className="text-muted-foreground">Shown</span>
          <button
            type="button"
            title={`Start this blur at the playhead (${at.toFixed(1)}s)`}
            onClick={() => onPatch({ start: at <= 0.001 ? undefined : +at.toFixed(3) })}
            className="rounded-md bg-panel-3 px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          >
            Starts here
          </button>
          <button
            type="button"
            title={`End this blur at the playhead (${at.toFixed(1)}s)`}
            onClick={() => onPatch({ end: at >= playDur - 0.001 ? undefined : +at.toFixed(3) })}
            className="rounded-md bg-panel-3 px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          >
            Ends here
          </button>
          <span className="tabular text-foreground">
            {win.from.toFixed(1)}–{win.to.toFixed(1)}s
          </span>
          {bounded && (
            <button
              type="button"
              title="Cover the whole clip again"
              onClick={() => onPatch({ start: undefined, end: undefined })}
              className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              whole clip
            </button>
          )}

          <Divider />

          <button
            type="button"
            title="Remove this region"
            onClick={onRemove}
            className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </>
      )}
      {/* The playhead sitting outside the selected region's window is the one
          state where the picture and the panel disagree, so it is said. */}
      {r && !isLiveAt(r, localTime, playDur) && (
        <span className="w-full text-center text-[10px] text-amber-400/90">
          Not shown at the playhead — this blur runs {win.from.toFixed(1)}–{win.to.toFixed(1)}s.
        </span>
      )}
      <button
        type="button"
        onClick={onDone}
        className="flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-brand-foreground"
      >
        <Check className="h-3 w-3" /> Done
      </button>
      {/* The one place the preview and the export genuinely differ, said out
          loud rather than left to look like a bug. */}
      {r?.kind === "pixelate" && (
        <span className="w-full text-center text-[10px] text-muted-foreground">
          Previews as a blur — CSS has no mosaic filter. The coverage is exact; the export is
          genuinely pixelated.
        </span>
      )}
    </div>
  );
}

function Divider() {
  return <span className="h-3 w-px bg-hairline" aria-hidden />;
}
