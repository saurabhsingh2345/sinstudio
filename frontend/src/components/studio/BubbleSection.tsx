import { useStudio } from "../../state";
import type { Bubble, Clip } from "../../types";
import { BUBBLE_DEFAULTS, bubbleCorner, bubbleLayout, type BubbleCorner } from "../../bubble";
import { ColorSwatch, Field, Section, SliderRow } from "./inspector-bits";

/*
The webcam bubble panel.

The corner buttons write ordinary transform x/y — a snapped bubble is still a
clip, draggable and keyframable, which is the whole architecture: the mask is
composited before the transform, so placement stays the transform's job.
*/
export function BubbleSection({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const doc = useStudio((s) => s.doc);
  const bb = clip.bubble;
  const canvas = doc?.canvas;

  const patch = (p: Partial<Bubble>) => updateClip(trackId, clip.id, { bubble: { ...(bb ?? {}), ...p } });

  const snap = (corner: BubbleCorner) => {
    if (!bb || !canvas) return;
    const g = bubbleLayout(bb, canvas.width, canvas.height);
    const { x, y } = bubbleCorner(corner, g, canvas.width, canvas.height);
    updateClip(trackId, clip.id, { transform: { ...clip.transform, x, y } });
  };

  return (
    <Section label="Webcam bubble" defaultOpen={!!bb}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1">
        <input
          type="checkbox"
          checked={!!bb}
          onChange={(e) => updateClip(trackId, clip.id, { bubble: e.target.checked ? {} : undefined })}
          className="accent-brand"
        />
        <span className="text-[11.5px]">Frame as a webcam bubble</span>
      </label>

      {bb && (
        <>
          <Field label="Shape">
            <div className="flex gap-1">
              {(["circle", "rounded"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => patch({ shape: s })}
                  className={`rounded px-2 py-1 text-[11px] ${(bb.shape ?? "circle") === s ? "bg-brand/90 text-white" : "bg-panel-3 text-muted-foreground hover:text-foreground"}`}
                >
                  {s === "circle" ? "Circle" : "Rounded"}
                </button>
              ))}
            </div>
          </Field>
          <SliderRow
            label="Size"
            value={Math.round((bb.size || BUBBLE_DEFAULTS.size) * 100)}
            min={10}
            max={60}
            step={2}
            onChange={(v) => patch({ size: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <SliderRow
            label="Ring"
            value={bb.border === undefined || bb.border === 0 ? BUBBLE_DEFAULTS.border : Math.max(0, bb.border)}
            min={0}
            max={20}
            step={1}
            onChange={(v) => patch({ border: v > 0 ? v : -1 })}
            fmt={(v) => (v > 0 ? `${v}px` : "off")}
          />
          <Field label="Ring color">
            <ColorSwatch color={bb.borderColor || BUBBLE_DEFAULTS.borderColor} onChange={(borderColor) => patch({ borderColor })} />
          </Field>
          <SliderRow
            label="Shadow"
            value={Math.round((bb.shadow || BUBBLE_DEFAULTS.shadow) * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(v) => patch({ shadow: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <Field label="Snap to">
            <div className="flex gap-1">
              {(
                [
                  ["tl", "↖"],
                  ["tr", "↗"],
                  ["center", "•"],
                  ["bl", "↙"],
                  ["br", "↘"],
                ] as [BubbleCorner, string][]
              ).map(([c, glyph]) => (
                <button
                  key={c}
                  onClick={() => snap(c)}
                  title={c}
                  className="h-6 w-7 rounded bg-panel-3 text-[12px] text-muted-foreground hover:text-foreground"
                >
                  {glyph}
                </button>
              ))}
            </div>
          </Field>
        </>
      )}
    </Section>
  );
}
