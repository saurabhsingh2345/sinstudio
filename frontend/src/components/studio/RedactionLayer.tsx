import { previewBlurPx } from "../../redaction";
import type { Redaction } from "../../types";

// The preview's stand-in for a redaction.
//
// The export resamples the region's actual pixels; the browser cannot do that
// to a playing <video>, so this lays a `backdrop-filter` over the same rectangle
// instead. What that buys is the thing that matters while editing — the region
// is exactly where it will be, at a strength that reads like the real one — and
// what it does not buy is a pixel-accurate match.
//
// Pixelate is the honest gap: CSS has no mosaic filter, so a pixelated region
// previews as a blur. The COVERAGE is exact either way, which is what you are
// checking when you place one; the texture differs until you export. The
// inspector says so rather than letting it look like a bug.

export function RedactionLayer({
  redactions,
  width,
  height,
  sourceWidth,
}: {
  redactions: Redaction[];
  /** The clip's displayed size on the preview stage, in screen px. */
  width: number;
  height: number;
  /** The asset's native width, so the blur radius can be carried into screen space. */
  sourceWidth: number;
}) {
  if (!redactions.length) return null;
  return (
    <>
      {redactions.map((r, i) => {
        const blur = previewBlurPx(r.amount, width, sourceWidth);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${r.x * 100}%`,
              top: `${r.y * 100}%`,
              width: `${r.w * 100}%`,
              height: `${r.h * 100}%`,
              // Both spellings: Safari still wants the prefix, and a redaction
              // silently not applying is the one failure mode worth avoiding.
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
}
