import { useEffect, useRef } from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";
import { MIN_CROP_SPAN, cropPixels, fullCrop } from "../../crop";
import { mediaUrl } from "../../types";
import type { Asset, Crop } from "../../types";

/*
 * Drag the edges of a clip's picture off.
 *
 * The whole source is shown, fitted into the preview frame, with everything
 * outside the crop dimmed rather than hidden. That is the point of a crop tool:
 * you are choosing what to remove, so what you are removing has to be visible
 * while you choose. A tool that showed only the surviving rectangle would let
 * you pull an edge in but never see what you were about to lose, or find the
 * edge again once it was gone.
 *
 * It deliberately ignores the clip's own scale and position. A clip zoomed to
 * 2x has half its source outside the frame, and those are exactly the edges a
 * crop most often wants — a mode where some handles cannot be reached is worse
 * than one that briefly reframes to show all of them.
 */
export function CropOverlay({
  asset,
  crop,
  localTime,
  stageW,
  stageH,
  onBegin,
  onChange,
  onCommit,
  onDone,
}: {
  asset: Asset;
  crop: Crop | undefined;
  /** Where the playhead sits inside the clip, so the frame shown is the one
   *  being looked at rather than the source's first. */
  localTime: number;
  stageW: number;
  stageH: number;
  onBegin: () => void;
  onChange: (c: Crop) => void;
  onCommit: () => void;
  onDone: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const keptRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // Seek both copies to the frame under the playhead. Not kept in sync during
  // playback: cropping is a stationary decision, and a moving picture under the
  // handles is harder to aim at, not easier.
  useEffect(() => {
    const seekAll = () => {
      for (const v of [videoRef.current, keptRef.current]) {
        if (!v) continue;
        try {
          v.currentTime = Math.max(0, localTime);
        } catch {
          /* not seekable yet; loadeddata will run this again */
        }
      }
    };
    seekAll();
    const els = [videoRef.current, keptRef.current].filter(Boolean) as HTMLVideoElement[];
    els.forEach((v) => v.addEventListener("loadeddata", seekAll));
    return () => els.forEach((v) => v.removeEventListener("loadeddata", seekAll));
  }, [localTime]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);

  const srcA = (asset.width || 16) / (asset.height || 9);
  const stageA = stageW / stageH;
  // The whole source, letterboxed into the stage — the frame the handles live
  // in and the space the crop's fractions are measured against.
  const fitW = stageA > srcA ? stageH * srcA : stageW;
  const fitH = stageA > srcA ? stageH : stageW / srcA;
  const fitX = (stageW - fitW) / 2;
  const fitY = (stageH - fitH) / 2;

  const c = fullCrop(crop);
  const rect = {
    left: c.left * fitW,
    top: c.top * fitH,
    width: (1 - c.left - c.right) * fitW,
    height: (1 - c.top - c.bottom) * fitH,
  };

  /*
   * One drag handler for all nine grips.
   *
   * `edges` names which sides this grip moves; the empty set means the whole
   * rectangle, which slides without changing size. Deltas are converted to
   * fractions of the fitted picture, so the maths is identical whatever size
   * the preview happens to be.
   */
  const drag =
    (edges: ("top" | "right" | "bottom" | "left")[]) =>
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const start = fullCrop(crop);
      onBegin();

      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - x0) / fitW;
        const dy = (ev.clientY - y0) / fitH;
        const next = { ...start };
        if (!edges.length) {
          // Moving the window: opposite edges change together, and the pair is
          // clamped as a unit so the rectangle keeps its size at the boundary
          // instead of squashing against it.
          const dxc = Math.max(-start.left, Math.min(start.right, dx));
          const dyc = Math.max(-start.top, Math.min(start.bottom, dy));
          next.left = start.left + dxc;
          next.right = start.right - dxc;
          next.top = start.top + dyc;
          next.bottom = start.bottom - dyc;
        } else {
          for (const edge of edges) {
            const d = edge === "left" || edge === "right" ? dx : dy;
            // Right and bottom are measured inward from their own side, so the
            // pointer's delta runs the other way.
            const raw = edge === "right" || edge === "bottom" ? start[edge] - d : start[edge] + d;
            const opposite =
              edge === "top" ? "bottom" : edge === "bottom" ? "top" : edge === "left" ? "right" : "left";
            next[edge] = Math.max(0, Math.min(1 - MIN_CROP_SPAN - start[opposite], raw));
          }
        }
        onChange(next);
      };
      const up = () => {
        onCommit();
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };

  const px = cropPixels(crop, asset.width, asset.height);
  const grip = "absolute h-3 w-3 rounded-[2px] border border-white bg-brand shadow-[0_0_0_1px_rgba(0,0,0,0.6)]";
  const bar = "absolute bg-white/70 hover:bg-white";

  return (
    <div ref={boxRef} className="absolute inset-0 z-10 select-none" style={{ touchAction: "none" }}>
      {/* The whole source, so what is being cut away stays visible. */}
      <div className="absolute overflow-hidden" style={{ left: fitX, top: fitY, width: fitW, height: fitH }}>
        {asset.kind === "image" ? (
          <img src={mediaUrl(asset.path, asset.createdAt)} className="h-full w-full" alt="" />
        ) : (
          <video
            ref={videoRef}
            src={mediaUrl(asset.path, asset.createdAt)}
            poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
            muted
            playsInline
            className="h-full w-full"
          />
        )}
        {/* Dim, not hide: the removed edges are the thing being judged. */}
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
        <div
          onPointerDown={drag([])}
          className="absolute cursor-move outline outline-1 outline-brand"
          style={rect}
        >
          {/*
            The kept region at full brightness: the same picture drawn again,
            above the dim and clipped to the crop. A CSS mask with a hole in it
            would be one element fewer and would have to be re-derived on every
            pointer move; this is just the same geometry, offset.
          */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            {asset.kind === "image" ? (
              <img
                src={mediaUrl(asset.path, asset.createdAt)}
                className="absolute max-w-none"
                style={{ left: -rect.left, top: -rect.top, width: fitW, height: fitH }}
                alt=""
              />
            ) : (
              <video
                ref={keptRef}
                src={mediaUrl(asset.path, asset.createdAt)}
                poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                muted
                playsInline
                className="absolute max-w-none"
                style={{ left: -rect.left, top: -rect.top, width: fitW, height: fitH }}
              />
            )}
          </div>
          {/* Thirds, the standard aid for judging a reframe. */}
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute left-1/3 top-0 h-full w-px bg-white/20" />
            <div className="absolute left-2/3 top-0 h-full w-px bg-white/20" />
            <div className="absolute left-0 top-1/3 h-px w-full bg-white/20" />
            <div className="absolute left-0 top-2/3 h-px w-full bg-white/20" />
          </div>

          {/* Edges: the wide grips, because "cut the top off" is one drag. */}
          <div onPointerDown={drag(["top"])} className={cn(bar, "-top-px left-3 right-3 h-1 cursor-ns-resize")} />
          <div onPointerDown={drag(["bottom"])} className={cn(bar, "-bottom-px left-3 right-3 h-1 cursor-ns-resize")} />
          <div onPointerDown={drag(["left"])} className={cn(bar, "-left-px top-3 bottom-3 w-1 cursor-ew-resize")} />
          <div onPointerDown={drag(["right"])} className={cn(bar, "-right-px top-3 bottom-3 w-1 cursor-ew-resize")} />

          <span onPointerDown={drag(["top", "left"])} className={cn(grip, "-left-1.5 -top-1.5 cursor-nwse-resize")} />
          <span onPointerDown={drag(["top", "right"])} className={cn(grip, "-right-1.5 -top-1.5 cursor-nesw-resize")} />
          <span onPointerDown={drag(["bottom", "left"])} className={cn(grip, "-left-1.5 -bottom-1.5 cursor-nesw-resize")} />
          <span onPointerDown={drag(["bottom", "right"])} className={cn(grip, "-right-1.5 -bottom-1.5 cursor-nwse-resize")} />
        </div>
      </div>

      <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-2 rounded-full border hairline bg-panel/90 px-3 py-1 text-[11px] shadow-lg backdrop-blur">
        <span className="font-medium">Crop</span>
        {/* The size the clip's picture actually becomes — the number that
            decides whether it still matches the other clips. */}
        <span className="tabular text-muted-foreground">
          {px.w}×{px.h}
        </span>
        <button
          type="button"
          onClick={onDone}
          className="flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-brand-foreground"
        >
          <Check className="h-3 w-3" /> Done
        </button>
      </div>
    </div>
  );
}
