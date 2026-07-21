import { useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { clipPlayDur, mediaUrl, type Asset, type Clip, type RedactKind, type Redaction } from "../../types";
import { REDACT_KINDS, clampRedaction, newRedaction, previewBlurPx } from "../../redaction";
import { Section, SliderRow } from "./inspector-bits";

// Hiding a password, a name, a licence key.
//
// The region is placed on a miniature of the clip's own frame — not the canvas —
// because that is the space it is stored in, and the whole point of that choice
// is that the region stays on the thing it hides when the clip is zoomed. Aiming
// it on a zoomed canvas view would put it somewhere else entirely.

type Handle = "move" | "resize";

export function RedactSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const updateClip = useStudio((s) => s.updateClip);
  const playhead = useStudio((s) => s.playhead);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [sel, setSel] = useState(0);

  const regions = clip.redactions ?? [];
  const selected: Redaction | undefined = regions[Math.min(sel, regions.length - 1)];

  const commit = (next: Redaction[]) =>
    updateClip(trackId, clip.id, { redactions: next.length ? next : undefined });

  const patch = (p: Partial<Redaction>) => {
    if (!selected) return;
    commit(regions.map((r) => (r === selected ? clampRedaction({ ...r, ...p }) : r)));
  };

  const add = () => {
    const next = [...regions, newRedaction()];
    commit(next);
    setSel(next.length - 1);
  };

  const remove = () => {
    if (!selected) return;
    commit(regions.filter((r) => r !== selected));
    setSel((i) => Math.max(0, i - 1));
  };

  // Keep the miniature on the frame being redacted, so you can see what you are
  // covering. Same source-time mapping the preview uses.
  const seek = () => {
    const v = videoRef.current;
    if (!v || asset.kind !== "video") return;
    const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const t = clip.in + Math.max(0, Math.min(clipPlayDur(clip), playhead - clip.start)) * sp;
    if (!Number.isFinite(t)) return;
    // Assigning the currentTime it already holds is not a seek, and a video that
    // has never seeked paints nothing — so nudge past it.
    v.currentTime = Math.abs(v.currentTime - t) > 0.05 ? t : t + 0.001;
  };

  const drag = (handle: Handle, region: Redaction) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const st = useStudio.getState();
    st.beginTransient();

    const start = { ...region };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const idx = regions.indexOf(region);

    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / rect.width;
      const dy = (ev.clientY - y0) / rect.height;
      const next =
        handle === "resize"
          ? { ...start, w: start.w + dx, h: start.h + dy }
          : { ...start, x: start.x + dx, y: start.y + dy };
      const cur = useStudio.getState().doc?.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clip.id);
      const list = (cur?.redactions ?? []).map((r, i) => (i === idx ? clampRedaction(next) : r));
      st.updateClip(trackId, clip.id, { redactions: list });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      useStudio.getState().commitTransient();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <Section label="Redact" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        Blurs part of the picture itself, so there is nothing to peel off the exported
        video. Regions travel with the footage when the clip is zoomed.
      </div>

      <div
        ref={boxRef}
        data-redact-stage
        className="relative w-full select-none overflow-hidden rounded-md border hairline bg-black/60"
        style={{ aspectRatio: `${asset.width || 16} / ${asset.height || 9}` }}
      >
        {asset.kind === "video" ? (
          <video
            ref={videoRef}
            src={mediaUrl(asset.path, asset.createdAt)}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={seek}
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        ) : (
          <img
            src={mediaUrl(asset.path, asset.createdAt)}
            alt=""
            className="pointer-events-none absolute inset-0 h-full w-full object-contain"
          />
        )}

        {regions.map((r, i) => (
          <div
            key={i}
            onPointerDown={drag("move", r)}
            className={cn(
              "absolute cursor-move border-2",
              r === selected ? "border-brand" : "border-white/50"
            )}
            style={{
              left: pct(r.x),
              top: pct(r.y),
              width: pct(r.w),
              height: pct(r.h),
              backdropFilter: `blur(${previewBlurPx(r.amount, boxRef.current?.clientWidth ?? 240, asset.width || 1920)}px)`,
              WebkitBackdropFilter: `blur(${previewBlurPx(r.amount, boxRef.current?.clientWidth ?? 240, asset.width || 1920)}px)`,
            }}
            onClickCapture={() => setSel(i)}
          >
            {r === selected && (
              <span
                onPointerDown={drag("resize", r)}
                className="absolute -bottom-1.5 -right-1.5 h-3 w-3 cursor-nwse-resize rounded-sm border-2 border-white bg-brand"
              />
            )}
          </div>
        ))}
      </div>

      <div className="flex gap-1.5">
        <Button size="sm" className="h-7 flex-1 bg-brand text-xs text-brand-foreground hover:bg-brand/90" onClick={add}>
          <Plus className="mr-1 h-3 w-3" /> Add region
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 bg-panel-3 px-2 text-xs"
          disabled={!selected}
          onClick={remove}
          title="Remove this region"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {regions.length > 1 && (
        <div className="flex flex-wrap gap-1">
          {regions.map((r, i) => (
            <button
              key={i}
              onClick={() => setSel(i)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[10px]",
                r === selected ? "bg-brand/20 text-foreground" : "bg-panel-3 text-muted-foreground"
              )}
            >
              {i + 1} · {r.kind}
            </button>
          ))}
        </div>
      )}

      {selected && (
        <>
          <Select value={selected.kind} onValueChange={(v) => patch({ kind: v as RedactKind })}>
            <SelectTrigger className="h-7 bg-panel-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {REDACT_KINDS.map((k) => (
                <SelectItem key={k.kind} value={k.kind}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <SliderRow
            label="Strength"
            value={Math.round((selected.amount ?? 0.6) * 100)}
            min={5}
            max={100}
            onChange={(v) => patch({ amount: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          {selected.kind === "pixelate" && (
            <div className="text-[10px] leading-relaxed text-muted-foreground">
              Previews as a blur — the browser has no mosaic filter. The region and its
              coverage are exact; the export is genuinely pixelated.
            </div>
          )}
        </>
      )}
    </Section>
  );
}
