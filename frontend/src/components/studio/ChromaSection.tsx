import { useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { mediaUrl, type Asset, type ChromaKey, type Clip } from "../../types";
import { newChroma, resolveChroma, rgbToHex } from "../../chroma";
import { ColorSwatch, Field, Section, SliderRow } from "./inspector-bits";

/*
The green screen panel.

The control that matters most is the colour, and typing a hex for it is
guesswork — a screen photographs as a range, none of which is the swatch it was
sold as. So the primary way to set it is clicking the screen in a still of the
actual footage, which is both more accurate than any default and the only way to
get a lit screen's real value.
*/
export function ChromaSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const updateClip = useStudio((s) => s.updateClip);
  const on = !!clip.chroma;

  const set = (patch: Partial<ChromaKey>) =>
    updateClip(trackId, clip.id, { chroma: { ...(clip.chroma ?? newChroma()), ...patch } });

  const c = resolveChroma(clip.chroma ?? {});

  return (
    <Section label="Green screen" defaultOpen={on}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => updateClip(trackId, clip.id, { chroma: e.target.checked ? newChroma() : undefined })}
          className="accent-brand"
        />
        <span className="text-[11.5px]">Key out a background colour</span>
      </label>

      {on && (
        <>
          <Picker asset={asset} color={c.color} onPick={(color) => set({ color })} />
          <Field label="Colour">
            <ColorSwatch color={c.color} onChange={(color) => set({ color })} />
          </Field>
          <SliderRow
            label="Amount"
            value={Math.round(c.similarity * 100)}
            min={1}
            max={100}
            onChange={(v) => set({ similarity: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <SliderRow
            label="Softness"
            value={Math.round(c.blend * 100)}
            min={0}
            max={50}
            onChange={(v) => set({ blend: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <SliderRow
            label="Despill"
            value={Math.round(c.spill * 100)}
            min={0}
            max={100}
            onChange={(v) => set({ spill: v / 100 })}
            fmt={(v) => (v === 0 ? "off" : `${v}%`)}
          />
          <p className="text-[10px] leading-snug text-muted-foreground">
            Raise Amount until the background goes, then stop — past that it starts eating the subject. Despill removes
            green light spilled onto edges.
          </p>
        </>
      )}
    </Section>
  );
}

/**
 * Click the screen in a frame of the footage to sample its colour.
 *
 * Uses the asset's thumbnail rather than the live preview: it is already
 * decoded, it is same-origin, and a still is easier to click accurately than a
 * moving picture. The pixel is read from a canvas at the image's natural size,
 * so what is sampled is the source pixel and not a scaled, resampled one — a
 * resampled pixel at the subject's edge is a blend of screen and subject, and
 * keying on it is what produces a fringe.
 */
function Picker({
  asset,
  color,
  onPick,
}: {
  asset: Asset;
  color: string;
  onPick: (hex: string) => void;
}) {
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [picking, setPicking] = useState(false);

  if (!asset.thumbnail) return null;

  const sample = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    // Map the click into the image's own pixels; the element is scaled to the
    // panel's width, so the ratio is not 1:1.
    const x = Math.round(((e.clientX - rect.left) / rect.width) * img.naturalWidth);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * img.naturalHeight);
    const cv = document.createElement("canvas");
    cv.width = img.naturalWidth;
    cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    ctx.drawImage(img, 0, 0);
    try {
      const d = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
      onPick(rgbToHex(d[0]!, d[1]!, d[2]!));
      setPicking(false);
    } catch {
      // A tainted canvas (a thumbnail served cross-origin) cannot be read.
      // The colour swatch below still works, so this degrades rather than fails.
      setPicking(false);
    }
  };

  return (
    <div className="space-y-1">
      <div className="relative overflow-hidden rounded border hairline bg-black">
        <img
          ref={imgRef}
          src={mediaUrl(asset.thumbnail, asset.createdAt)}
          crossOrigin="anonymous"
          alt=""
          onClick={picking ? sample : undefined}
          className={cn("w-full", picking && "cursor-crosshair")}
        />
        {picking && <div className="pointer-events-none absolute inset-0 ring-2 ring-inset ring-brand" />}
      </div>
      <div className="flex items-center gap-1.5">
        <button
          onClick={() => setPicking((p) => !p)}
          className={cn(
            "h-6 flex-1 rounded border hairline text-[10.5px]",
            picking ? "bg-brand text-white" : "bg-panel-2 hover:bg-panel-3"
          )}
        >
          {picking ? "Click the background…" : "Pick from the frame"}
        </button>
        <span className="h-5 w-5 rounded border hairline" style={{ background: color }} />
      </div>
    </div>
  );
}
