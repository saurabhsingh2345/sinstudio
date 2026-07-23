import { useEffect, useRef } from "react";
import type { EditDoc, Track, Clip } from "../../types";
import { clipBox } from "./preview-engine";
import { drawLumaScope, lumaHistogram, solidFromBackground } from "../../lumaHistogram";

const SAMPLE_W = 160;
const SAMPLE_H = 90;
const SCOPE_W = 240;
const SCOPE_H = 96;

type Visual = { track: Track; clip: Clip };

export function LumaScope({
  visible,
  frameRef,
  videoRefs,
  visuals,
  playhead,
  stage,
  canvasW,
  canvasH,
  bg,
}: {
  visible: boolean;
  frameRef: React.RefObject<HTMLDivElement | null>;
  videoRefs: React.MutableRefObject<Record<string, HTMLVideoElement | null>>;
  visuals: Visual[];
  playhead: number;
  stage: { w: number; h: number };
  canvasW: number;
  canvasH: number;
  bg: string;
}) {
  const scopeRef = useRef<HTMLCanvasElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!visible) return;

    let raf = 0;
    const sample =
      sampleRef.current ??
      (() => {
        const c = document.createElement("canvas");
        sampleRef.current = c;
        return c;
      })();
    sample.width = SAMPLE_W;
    sample.height = SAMPLE_H;
    const sctx = sample.getContext("2d", { willReadFrequently: true });
    if (!sctx) return;

    const tick = () => {
      const scope = scopeRef.current;
      if (scope && frameRef.current && sctx) {
        sctx.fillStyle = solidFromBackground(bg);
        sctx.fillRect(0, 0, SAMPLE_W, SAMPLE_H);

        const sx = SAMPLE_W / stage.w;
        const sy = SAMPLE_H / stage.h;

        for (const { track, clip } of visuals) {
          if (clip.title || clip.annotation || !clip.assetId) continue;
          const v = videoRefs.current[clip.id];
          if (!v || v.readyState < 2) continue;
          const box = clipBox(clip, playhead, stage.w, stage.h, canvasW, canvasH);
          try {
            sctx.drawImage(v, box.left * sx, box.top * sy, box.vw * sx, box.vh * sy);
          } catch {
            // Cross-origin or mid-decode — skip this layer.
          }
        }

        const bins = lumaHistogram(sctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data);
        scope.width = SCOPE_W;
        scope.height = SCOPE_H;
        const ctx = scope.getContext("2d");
        if (ctx) drawLumaScope(ctx, bins, SCOPE_W, SCOPE_H);
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [visible, frameRef, videoRefs, visuals, playhead, stage, canvasW, canvasH, bg]);

  if (!visible) return null;

  return (
    <canvas
      ref={scopeRef}
      width={SCOPE_W}
      height={SCOPE_H}
      className="pointer-events-none absolute right-2.5 bottom-2.5 rounded-md border hairline shadow-lg"
      aria-hidden
    />
  );
}
