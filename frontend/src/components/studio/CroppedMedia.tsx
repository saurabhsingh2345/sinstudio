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
            // The thumbnail stands in until the first frame decodes; without it
            // a freshly-opened project is a black rectangle for as long as the
            // media takes to load, which reads as a broken recording.
            poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
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
