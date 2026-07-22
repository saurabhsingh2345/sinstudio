import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { clipPlayDur, mediaUrl, type Asset, type Clip } from "../../types";
import { cursorTrackNow } from "../../cursorTracks";
import {
  DEFAULT_EASE,
  DEFAULT_RAMP,
  MAX_ZOOM,
  applyZoomStops,
  clampRect,
  readZoomStops,
  rectForZoom,
  upsertStop,
  type Rect,
  type Size,
  type ZoomStop,
} from "../../zoomPan";
import { Field, NumInput, Section, SliderRow } from "./inspector-bits";

// Zoom-n-pan: say which part of the frame to zoom into by dragging a rectangle
// over it, instead of typing scale and offset numbers and checking the result.
//
// The rectangle is only ever an editing surface. What gets written is the same
// scale/x/y keyframes SmartFocus writes, so a hand-placed zoom is indistinguish-
// able from an auto-detected one downstream, remains draggable on the timeline,
// and needs nothing new from the renderer.

const CORNERS = ["nw", "ne", "sw", "se"] as const;
type Corner = (typeof CORNERS)[number];

const fmtTime = (t: number) => `${t.toFixed(2)}s`;

export function ZoomPanSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset?: Asset }) {
  const projectId = useStudio((s) => s.doc?.id ?? "");
  const canvas = useStudio((s) => s.doc?.canvas);
  const playhead = useStudio((s) => s.playhead);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const updateClip = useStudio((s) => s.updateClip);

  const [sel, setSel] = useState(0);
  const [draft, setDraft] = useState<Rect | null>(null); // live rectangle mid-drag
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  const duration = clipPlayDur(clip);

  // The source's own pixel size. A recording that is not the canvas's shape is
  // FITTED into it — a 3456x2234 capture on a 16:9 canvas sits centred with bars
  // beside it — so every clamp below has to stop at the picture's edge, not the
  // canvas's. Without this a rectangle could be placed over a bar and the camera
  // would dutifully pan there, filling the frame with background instead of
  // magnifying anything. SmartFocus has always clamped this way; see contentBox.
  const video = useMemo(
    () => (asset && asset.width > 0 && asset.height > 0 ? { width: asset.width, height: asset.height } : undefined),
    [asset]
  );

  const stops = useMemo(
    () => (canvas ? readZoomStops(clip.keyframes, canvas, video) : []),
    [clip.keyframes, canvas, video]
  );

  // Clip-local time; the panel is about this clip, not the project.
  const localT = Math.max(0, Math.min(duration, playhead - clip.start));

  const selected: ZoomStop | undefined = stops[Math.min(sel, stops.length - 1)];
  const rect = draft ?? selected?.rect ?? null;

  // Keep the backdrop on the frame being edited. Same mapping the preview uses,
  // so what you aim at is what the export zooms into.
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !asset || asset.kind !== "video") return;
    const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const at = clip.in + localT * sp;
    if (!Number.isFinite(at)) return;
    const seek = () => {
      // A video that has never seeked paints nothing, and assigning the
      // currentTime it already holds is not a seek — so at t=0 (the common case
      // when the panel first opens) the stage would stay blank. Nudge past it.
      v.currentTime = Math.abs(v.currentTime - at) > 0.05 ? at : at + 0.001;
    };
    if (v.readyState >= 1) seek();
    else v.addEventListener("loadedmetadata", seek, { once: true });
    return () => v.removeEventListener("loadedmetadata", seek);
  }, [asset, clip.in, clip.speed, localT]);

  if (!canvas) return null;

  const commit = (next: ZoomStop[]) =>
    updateClip(trackId, clip.id, {
      keyframes: applyZoomStops(clip.keyframes, next, duration, canvas, video),
    });

  const patchSelected = (patch: Partial<ZoomStop>) => {
    if (!selected) return;
    // A timing change can push a stop into its neighbour; upsert resolves that
    // the same way placing a new zoom does.
    const next = { ...selected, ...patch };
    const list = upsertStop(stops.filter((s) => s !== selected), next);
    commit(list);
    setSel(list.indexOf(next));
  };

  /** Where a new zoom should aim: at the pointer if we recorded one, else the middle. */
  const defaultCentre = () => {
    const track = asset ? cursorTrackNow(projectId, asset.id) : null;
    if (track && track.samples.length && track.video.width > 0) {
      const ms = localT * 1000;
      let best = track.samples[0];
      for (const s of track.samples) {
        if (Math.abs(s.t - ms) < Math.abs(best.t - ms)) best = s;
      }
      return {
        x: (best.x / track.video.width) * canvas.width,
        y: (best.y / track.video.height) * canvas.height,
      };
    }
    return { x: canvas.width / 2, y: canvas.height / 2 };
  };

  const addZoom = () => {
    const start = +localT.toFixed(3);
    const end = +Math.min(duration, start + 2).toFixed(3);
    if (end - start < 0.1) {
      // No room left in the clip to hold a zoom.
      return;
    }
    const next = upsertStop(stops, {
      start,
      end,
      rect: rectForZoom(2, defaultCentre(), canvas, video),
      ramp: DEFAULT_RAMP,
      ease: DEFAULT_EASE,
    });
    commit(next);
    setSel(next.findIndex((s) => s.start === start));
  };

  const removeSelected = () => {
    if (!selected) return;
    commit(stops.filter((s) => s !== selected));
    setSel((i) => Math.max(0, i - 1));
  };

  // --- direct manipulation --------------------------------------------------

  /** Canvas px per screen px, so a drag in the little box means the right thing. */
  const perPx = () => {
    const w = boxRef.current?.clientWidth || 1;
    return canvas.width / w;
  };

  const drag = (e: React.PointerEvent, onMove: (dx: number, dy: number) => Rect) => {
    if (e.button !== 0 || !selected) return;
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const k = perPx();
    const st = useStudio.getState();
    st.beginTransient(); // the whole drag is one undo step

    const before = clip.keyframes; // scale/x/y are replaced wholesale, so this stays valid
    const move = (ev: PointerEvent) => {
      const next = onMove((ev.clientX - x0) * k, (ev.clientY - y0) * k);
      setDraft(next);
      // Live, so the main preview follows the rectangle rather than jumping on release.
      st.updateClip(trackId, clip.id, {
        keyframes: applyZoomStops(
          before,
          stops.map((s) => (s === selected ? { ...s, rect: next } : s)),
          duration,
          canvas,
          video
        ),
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDraft(null);
      useStudio.getState().commitTransient();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onMoveDown = (e: React.PointerEvent) => {
    if (!selected) return;
    const start = selected.rect;
    drag(e, (dx, dy) => clampRect({ ...start, x: start.x + dx, y: start.y + dy }, canvas, video));
  };

  const onCornerDown = (corner: Corner) => (e: React.PointerEvent) => {
    if (!selected) return;
    const start = selected.rect;
    // The opposite corner stays put, and width drives height — one `scale`
    // drives both axes, so a free-form rectangle is not representable.
    const west = corner === "nw" || corner === "sw";
    const north = corner === "nw" || corner === "ne";
    const fixedX = west ? start.x + start.w : start.x;
    const fixedY = north ? start.y + start.h : start.y;
    drag(e, (dx) => {
      // clampRect settles the legal width (and the height that follows from it)
      // before the anchored corner is worked back out from it.
      const sized = clampRect({ x: 0, y: 0, w: start.w + (west ? -dx : dx), h: 0 }, canvas);
      return clampRect(
        {
          x: west ? fixedX - sized.w : fixedX,
          y: north ? fixedY - sized.h : fixedY,
          w: sized.w,
          h: sized.h,
        },
        canvas
      );
    });
  };

  // --- render ---------------------------------------------------------------

  const zoomOf = (r: Rect) => canvas.width / r.w;

  return (
    <Section label="Zoom & pan" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        Drag the box over what should fill the frame. Writes normal keyframes, so every
        zoom stays editable on the timeline.
      </div>

      <ZoomStage
        boxRef={boxRef}
        videoRef={videoRef}
        asset={asset}
        canvas={canvas}
        rect={rect}
        onMoveDown={onMoveDown}
        onCornerDown={onCornerDown}
      />

      {stops.length === 0 ? (
        <div className="text-[10.5px] leading-relaxed text-muted-foreground">
          No zooms on this clip yet.
        </div>
      ) : (
        <div className="space-y-1">
          {stops.map((s, i) => (
            <button
              key={`${s.start}-${i}`}
              onClick={() => {
                setSel(i);
                setPlayhead(+(clip.start + s.start).toFixed(3));
              }}
              className={cn(
                "flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[11px]",
                s === selected ? "bg-brand/15 text-foreground" : "text-muted-foreground hover:bg-panel-3"
              )}
            >
              <span className="tabular w-20 shrink-0">
                {fmtTime(s.start)}–{fmtTime(s.end)}
              </span>
              <span className="tabular flex-1">{zoomOf(s.rect).toFixed(2)}×</span>
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 flex-1 bg-brand text-xs text-brand-foreground hover:bg-brand/90" onClick={addZoom}>
          <Plus className="mr-1 h-3 w-3" /> Zoom at playhead
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 bg-panel-3 px-2 text-xs"
          disabled={!selected}
          onClick={removeSelected}
          title="Remove this zoom"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {selected && (
        <>
          <SliderRow
            label="Zoom"
            value={Math.round(zoomOf(selected.rect) * 100)}
            min={100}
            max={MAX_ZOOM * 100}
            step={5}
            fmt={(v) => `${(v / 100).toFixed(2)}×`}
            onChange={(v) => {
              const r = selected.rect;
              patchSelected({
                rect: rectForZoom(v / 100, { x: r.x + r.w / 2, y: r.y + r.h / 2 }, canvas),
              });
            }}
          />
          <div className="grid grid-cols-2 gap-2">
            <Field label="From">
              <NumInput
                value={selected.start}
                step={0.1}
                min={0}
                max={duration}
                suffix="s"
                onChange={(v) => patchSelected({ start: Math.min(v, selected.end - 0.1) })}
              />
            </Field>
            <Field label="To">
              <NumInput
                value={selected.end}
                step={0.1}
                min={0}
                max={duration}
                suffix="s"
                onChange={(v) => patchSelected({ end: Math.max(v, selected.start + 0.1) })}
              />
            </Field>
          </div>
          <SliderRow
            label="Move in"
            value={Math.round(selected.ramp * 100)}
            min={10}
            max={200}
            step={5}
            fmt={(v) => `${(v / 100).toFixed(2)}s`}
            onChange={(v) => patchSelected({ ramp: v / 100 })}
          />
          <Field label="Ease">
            <Select value={selected.ease} onValueChange={(v) => patchSelected({ ease: v })}>
              <SelectTrigger className="h-7 bg-panel-2 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="easeInOut">Smooth</SelectItem>
                <SelectItem value="easeOutCubic">Ease out</SelectItem>
                <SelectItem value="easeInCubic">Ease in</SelectItem>
                <SelectItem value="linear">Linear</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-full text-[10px] text-muted-foreground"
            onClick={() => {
              const c = defaultCentre();
              patchSelected({ rect: rectForZoom(zoomOf(selected.rect), c, canvas) });
            }}
            title="Centre this zoom on the pointer at the playhead"
          >
            <Crosshair className="mr-1 h-3 w-3" /> Centre on pointer
          </Button>
        </>
      )}
    </Section>
  );
}

/** The little frame with the draggable zoom rectangle over it. */
function ZoomStage({
  boxRef,
  videoRef,
  asset,
  canvas,
  rect,
  onMoveDown,
  onCornerDown,
}: {
  boxRef: React.MutableRefObject<HTMLDivElement | null>;
  videoRef: React.MutableRefObject<HTMLVideoElement | null>;
  asset?: Asset;
  canvas: Size;
  rect: Rect | null;
  onMoveDown: (e: React.PointerEvent) => void;
  onCornerDown: (c: Corner) => (e: React.PointerEvent) => void;
}) {
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded-md border hairline bg-black/60 select-none"
      style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
    >
      {asset?.kind === "video" && (
        <video
          ref={videoRef}
          src={mediaUrl(asset.path, asset.createdAt)}
          muted
          playsInline
          preload="metadata"
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
      )}
      {asset?.kind === "image" && (
        <img
          src={mediaUrl(asset.path, asset.createdAt)}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-contain"
        />
      )}

      {rect && (
        <>
          {/* The huge spread dims everything OUTSIDE the rectangle — what the
              zoom throws away — while leaving the kept region at full contrast. */}
          <div
            onPointerDown={onMoveDown}
            className="absolute cursor-move border-2 border-brand shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
            style={{
              left: pct(rect.x, canvas.width),
              top: pct(rect.y, canvas.height),
              width: pct(rect.w, canvas.width),
              height: pct(rect.h, canvas.height),
            }}
          >
            {CORNERS.map((c) => (
              <span
                key={c}
                onPointerDown={onCornerDown(c)}
                className={cn(
                  "absolute h-2.5 w-2.5 rounded-sm border border-brand bg-background",
                  c === "nw" && "-left-1.5 -top-1.5 cursor-nwse-resize",
                  c === "ne" && "-right-1.5 -top-1.5 cursor-nesw-resize",
                  c === "sw" && "-bottom-1.5 -left-1.5 cursor-nesw-resize",
                  c === "se" && "-bottom-1.5 -right-1.5 cursor-nwse-resize"
                )}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
