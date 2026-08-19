import { cropLayout } from "../../crop";
import { mediaUrl } from "../../types";
import type { Asset, Clip, Crop } from "../../types";

/*
 * A clip's picture, cropped and fitted, inside whatever box it has been given.
 *
 * This replaces `object-fit` everywhere the preview draws media. object-fit can
 * express two of the three fits and neither of them with a crop applied: there
 * is no way to say "show this rectangle of the source, scaled to cover". So the
 * element is sized to the WHOLE source and positioned so the surviving
 * rectangle lands where it belongs, and the parent clips the rest — which is
 * one rule covering all three fits and every crop, and is arithmetically the
 * same thing the exporter's crop+scale pair does.
 *
 * The parent must be positioned and is expected to hide its overflow; `width`
 * and `height` are that parent's size in stage pixels, which this cannot read
 * off the DOM without a layout pass per frame.
 */
export function CroppedMedia({
  asset,
  crop,
  width,
  height,
  mode,
  focus,
  muted,
  onVideo,
  filter,
}: {
  asset: Asset;
  crop: Crop | undefined;
  width: number;
  height: number;
  mode: "fit" | "fill" | "stretch";
  /** Which part of an overflowing picture survives — see cropLayout. */
  focus?: [number, number];
  muted?: boolean;
  onVideo?: (el: HTMLVideoElement | null) => void;
  filter?: string;
}) {
  const src = { width: asset.width || width, height: asset.height || height };
  const { window: win, media } = cropLayout(crop, src, width, height, mode, focus);
  const style: React.CSSProperties = {
    position: "absolute",
    ...media,
    // The element is already exactly the source's shape, so there is nothing
    // for a fit rule to do — and "fill" is the one that keeps it that way in
    // stretch mode, where the two axes are deliberately scaled apart.
    objectFit: "fill",
    maxWidth: "none",
    // The picture is never an interaction target: it has no controls and no
    // handlers, and everything on the stage you can actually grab — the
    // selection box, the crop and redaction overlays — is painted above the
    // clips. Left alive it swallowed clicks meant for whatever was behind it,
    // and a clip primed for an upcoming cut sits over the live one.
    pointerEvents: "none",
    filter,
  };
  return (
    // Two nested clips, and both are load-bearing. The outer one holds a filled
    // clip inside the canvas; the inner one is the crop itself, and without it
    // the trimmed edges reappear in the letterbox bars of a fitted clip.
    <div style={{ position: "absolute", inset: 0, overflow: "hidden" }}>
      <div style={{ position: "absolute", ...win, overflow: "hidden" }}>
        {asset.kind === "image" ? (
          <img src={mediaUrl(asset.path, asset.createdAt)} style={style} alt="" />
        ) : (
          <video
            ref={onVideo}
            src={mediaUrl(asset.path, asset.createdAt)}
            /*
             * No `poster`.
             *
             * It used to be the asset's thumbnail, to stand in until the first
             * frame decoded — but that thumbnail is the frame from the MIDDLE of
             * the source file (see importAsset: at = duration/2), and it has
             * nothing to do with where this clip is trimmed to. A browser paints
             * the poster whenever the element has no frame for its current
             * position, which is the case for the whole of every mount, so every
             * cut to a new clip flashed a still from somewhere else in the
             * recording before the real picture arrived: the stray screenshots
             * between scenes. The stand-in was a worse lie than a moment of the
             * canvas, and with the preview priming clips before they are due
             * (see upcomingVisuals) there is no moment left to fill.
             *
             * preload=auto for the same reason — fetch and decode as soon as the
             * element exists rather than waiting to be played.
             */
            preload="auto"
            muted={muted}
            playsInline
            style={style}
          />
        )}
      </div>
    </div>
  );
}

/** The clip's picture size on the timeline, for callers that need the box. */
export function clipCropOf(clip: Pick<Clip, "crop">): Crop | undefined {
  return clip.crop;
}
