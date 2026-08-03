import { previewBlurPx, redactionRect } from "../../redaction";
import type { CropLayout } from "../../crop";
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
//
// Geometry comes from the clip's cropLayout, not from its box. A redaction is a
// fraction of the UNCROPPED source — the renderer applies it before the crop —
// so it belongs to `media`, the whole source laid out in the box. Measuring it
// against the box instead is right only until someone crops the clip, and then
// silently draws the blur somewhere the export will not put it.

export function RedactionLayer({
  redactions,
  layout,
  sourceWidth,
}: {
  redactions: Redaction[];
  layout: CropLayout;
  /** The asset's native width, so the blur radius can be carried into screen space. */
  sourceWidth: number;
}) {
  if (!redactions.length) return null;
  const { window: win, media } = layout;
  return (
    // The crop's surviving window clips the regions, so a blur on an edge that
    // was trimmed away does not go on painting over the letterbox bar.
    <div
      style={{
        position: "absolute",
        left: win.left,
        top: win.top,
        width: win.width,
        height: win.height,
        overflow: "hidden",
        pointerEvents: "none",
      }}
    >
      {redactions.map((r, i) => {
        const rect = redactionRect(r, media);
        // Scaled against the width the SOURCE is displayed at, which is what
        // media.width is — the box's width is the cropped picture's.
        const blur = previewBlurPx(r.amount, media.width, sourceWidth);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              // Already window-relative — this element's origin IS the window,
              // and so is cropLayout's `media`, which the rect was measured
              // against. Subtracting the window's offset here would shift every
              // region by it.
              left: rect.left,
              top: rect.top,
              width: rect.width,
              height: rect.height,
              // Both spellings: Safari still wants the prefix, and a redaction
              // silently not applying is the one failure mode worth avoiding.
              backdropFilter: `blur(${blur}px)`,
              WebkitBackdropFilter: `blur(${blur}px)`,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </div>
  );
}
