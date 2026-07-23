import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import { clipPlayDur, mediaUrl, type Annotation, type AnnoKind, type Clip } from "../../types";
import { annoBox, ANNO_KINDS, clampAnno, isArrow, newAnnotation, resolveAnno } from "../../annotation";
import { AnnotationLayer } from "./AnnotationLayer";
import { ColorSwatch, Field, NumInput, Section, SliderRow } from "./inspector-bits";

// The callout editor. Placement is a drag on a miniature of the frame rather
// than four number fields — a callout points at something, and you cannot aim
// it at a thing you cannot see.
//
// The stage shows whatever footage sits under the callout at the playhead, so
// what you are pointing at is actually on screen while you place the arrow.

/** Kinds that carry a text label, and so get the Label section and a fill. */
const LABELLED = new Set<string>(["number", "text", "keys"]);

export function AnnotationInspector({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const updateAnnotation = useStudio((s) => s.updateAnnotation);
  const anno = clip.annotation!;
  const a = resolveAnno(anno);

  const set = (patch: Partial<Annotation>) => updateAnnotation(trackId, clip.id, patch);

  return (
    <>
      <Section label="Callout">
        <Field label="Type">
          <Select
            value={anno.kind}
            onValueChange={(v) => {
              // Switching kind keeps the geometry you already placed; only the
              // fields the new kind needs and the old one lacked are seeded.
              const seed = newAnnotation(v as AnnoKind);
              const next: Annotation = { ...seed, ...anno, kind: v as AnnoKind };
              if (isArrow(next) && !next.x2 && !next.y2) {
                next.x2 = seed.x2;
                next.y2 = seed.y2;
              }
              if (!isArrow(next) && !next.w) {
                next.w = seed.w;
                next.h = seed.h;
              }
              if (LABELLED.has(v) && !next.text) next.text = seed.text;
              if (LABELLED.has(v) && !next.fill) next.fill = seed.fill;
              updateClip(trackId, clip.id, { annotation: next });
            }}
          >
            <SelectTrigger className="h-7 bg-panel-2 text-[12px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ANNO_KINDS.map((k) => (
                <SelectItem key={k.kind} value={k.kind}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <AnnoStage trackId={trackId} clip={clip} />

        <div className="text-[10px] leading-relaxed text-muted-foreground">
          {isArrow(anno)
            ? "Drag either end to aim the arrow."
            : "Drag the shape to move it, its corner to resize."}
        </div>
      </Section>

      <Section label="Look">
        <Field label="Colour">
          <ColorSwatch color={a.color} onChange={(c) => set({ color: c })} />
        </Field>
        {anno.kind !== "highlight" && !LABELLED.has(anno.kind) && (
          <>
            <SliderRow
              label="Thickness"
              value={a.thickness}
              min={1}
              max={40}
              onChange={(v) => set({ thickness: v })}
              fmt={(v) => `${v}px`}
            />
            <ToggleFill anno={anno} onChange={set} />
          </>
        )}
        {anno.kind === "keys" && (
          // A keycap always has a border, so it gets the width without the
          // on/off toggle the outline shapes need.
          <SliderRow
            label="Border"
            value={a.thickness}
            min={0}
            max={12}
            onChange={(v) => set({ thickness: v })}
            fmt={(v) => (v === 0 ? "none" : `${v}px`)}
          />
        )}
        {(anno.kind === "highlight" || LABELLED.has(anno.kind)) && (
          <Field label="Fill">
            <ColorSwatch color={a.fill || a.color} onChange={(c) => set({ fill: c })} />
          </Field>
        )}
        {anno.kind !== "arrow" && anno.kind !== "ellipse" && (
          <SliderRow
            label="Corners"
            value={a.radius}
            min={0}
            max={60}
            onChange={(v) => set({ radius: v })}
            fmt={(v) => `${v}px`}
          />
        )}
        <SliderRow
          label="Opacity"
          value={Math.round(a.opacity * 100)}
          min={5}
          max={100}
          onChange={(v) => set({ opacity: v / 100 })}
          fmt={(v) => `${v}%`}
        />
      </Section>

      {LABELLED.has(anno.kind) && (
        <Section label={anno.kind === "keys" ? "Keys" : "Label"}>
          {anno.kind === "keys" ? (
            <KeysField value={a.text} onChange={(text) => set({ text })} />
          ) : (
            <Input
              value={a.text}
              onChange={(e) => set({ text: e.target.value })}
              className="h-7 bg-panel-2 text-[12px]"
              placeholder={anno.kind === "number" ? "1" : "Click here"}
            />
          )}
          <Field label="Colour">
            <ColorSwatch color={a.textColor} onChange={(c) => set({ textColor: c })} />
          </Field>
          <SliderRow
            label="Size"
            value={a.textSize}
            min={0}
            max={140}
            onChange={(v) => set({ textSize: v })}
            fmt={(v) => (v === 0 ? "auto" : `${v}px`)}
          />
        </Section>
      )}

      <Section label="Timing">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start">
            <NumInput
              value={clip.start}
              step={0.1}
              min={0}
              suffix="s"
              onChange={(v) => updateClip(trackId, clip.id, { start: v })}
            />
          </Field>
          <Field label="Dur">
            <NumInput
              value={clipPlayDur(clip)}
              step={0.1}
              min={0.1}
              suffix="s"
              onChange={(v) => updateClip(trackId, clip.id, { out: clip.in + v })}
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Fade in">
            <NumInput
              value={clip.fadeIn ?? 0}
              step={0.1}
              min={0}
              suffix="s"
              onChange={(v) => updateClip(trackId, clip.id, { fadeIn: v })}
            />
          </Field>
          <Field label="Fade out">
            <NumInput
              value={clip.fadeOut ?? 0}
              step={0.1}
              min={0}
              suffix="s"
              onChange={(v) => updateClip(trackId, clip.id, { fadeOut: v })}
            />
          </Field>
        </div>
      </Section>
    </>
  );
}

/*
Modifier labels, in words rather than the Mac symbols.

The renderer's font has no ⌘ or ⇧, so a captured symbol would export as a tofu
box — see KEY_SYMBOLS in annotation.ts. Capturing the word form means the field
shows exactly what the export draws, instead of looking right here and breaking
later. Names still follow the platform, because "Cmd" and "Win" are what is
printed on the key the viewer is looking at.
*/
const IS_MAC = typeof navigator !== "undefined" && /Mac|iP(hone|ad)/.test(navigator.platform || navigator.userAgent);
const MOD_LABELS = IS_MAC
  ? { meta: "Cmd", alt: "Opt", shift: "Shift", ctrl: "Ctrl" }
  : { meta: "Win", alt: "Alt", shift: "Shift", ctrl: "Ctrl" };

/** The printable name of the non-modifier key in a KeyboardEvent. */
function keyLabel(e: React.KeyboardEvent): string {
  const k = e.key;
  if (["Meta", "Alt", "Shift", "Control"].includes(k)) return "";
  const named: Record<string, string> = {
    " ": "Space",
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Backspace: "Bksp",
    Tab: "Tab",
  };
  if (named[k]) return named[k];
  // A single character comes back lower-case unless Shift is down; a keycap is
  // conventionally upper-case regardless of how it was typed.
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * The keys to display, typed or captured.
 *
 * Capture here is just a focused input reading its own keydown — the browser
 * gives that away for free to a field that has focus. It is NOT keystroke
 * recording: nothing is watched while you record, nothing is stored, and the
 * app asks for no permission. Pressing the shortcut is simply a faster and
 * more accurate way to fill this box than spelling it out.
 */
function KeysField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [capturing, setCapturing] = useState(false);
  return (
    <div className="space-y-1">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 bg-panel-2 text-[12px]"
        placeholder="Cmd+C"
      />
      <Button
        type="button"
        variant={capturing ? "default" : "secondary"}
        className="h-7 w-full text-[11px]"
        onFocus={() => setCapturing(true)}
        onBlur={() => setCapturing(false)}
        onKeyDown={(e) => {
          // Every key is consumed while focused, or Tab and Enter would leave
          // the field instead of being captured — they are shortcuts too.
          e.preventDefault();
          e.stopPropagation();
          const parts: string[] = [];
          if (e.ctrlKey) parts.push(MOD_LABELS.ctrl);
          if (e.altKey) parts.push(MOD_LABELS.alt);
          if (e.shiftKey) parts.push(MOD_LABELS.shift);
          if (e.metaKey) parts.push(MOD_LABELS.meta);
          const k = keyLabel(e);
          if (k) parts.push(k);
          // A bare modifier is a chord still being formed, not a shortcut.
          if (k) onChange(parts.join("+"));
        }}
      >
        {capturing ? "Press the shortcut…" : "Capture a shortcut"}
      </Button>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Separate keys with <span className="tabular">+</span>. Nothing is recorded while you capture — this only reads
        the field you're typing in.
      </p>
    </div>
  );
}

function ToggleFill({ anno, onChange }: { anno: Annotation; onChange: (p: Partial<Annotation>) => void }) {
  const on = !!anno.fill;
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1">
      <input
        type="checkbox"
        checked={on}
        onChange={(e) => onChange({ fill: e.target.checked ? anno.color || "#f5a524" : "" })}
        className="accent-brand"
      />
      <span className="text-[11.5px]">Fill the shape</span>
    </label>
  );
}

type Handle = "move" | "resize" | "p1" | "p2";

/** A miniature of the frame with the callout on it, draggable. */
function AnnoStage({ trackId, clip }: { trackId: string; clip: Clip }) {
  const doc = useStudio((s) => s.doc);
  const playhead = useStudio((s) => s.playhead);
  const updateAnnotation = useStudio((s) => s.updateAnnotation);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<Handle | null>(null);

  const anno = clip.annotation!;
  const a = resolveAnno(anno);
  // Computed rather than read from w/h, so the drag box wraps a keystroke badge
  // whose size is derived from its text.
  const box = annoBox(anno);
  const canvas = doc?.canvas;

  // Whatever footage is under the callout right now, so you can aim at it.
  const under = (() => {
    if (!doc) return null;
    for (const t of doc.tracks) {
      if (t.kind !== "video" && t.kind !== "background") continue;
      for (const c of t.clips ?? []) {
        if (c.annotation || c.title || c.disabled) continue;
        if (playhead < c.start || playhead > c.start + clipPlayDur(c)) continue;
        const asset = doc.assets.find((x) => x.id === c.assetId);
        if (asset && (asset.kind === "video" || asset.kind === "image") && asset.thumbnail) return asset;
      }
    }
    return null;
  })();

  if (!canvas) return null;

  const drag = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const st = useStudio.getState();
    st.beginTransient();
    setDragging(handle);

    const start = { ...anno };
    const x0 = e.clientX;
    const y0 = e.clientY;

    const move = (ev: PointerEvent) => {
      // Fractions of the frame, which is exactly the unit the shape is stored in.
      const dx = (ev.clientX - x0) / rect.width;
      const dy = (ev.clientY - y0) / rect.height;
      let next: Annotation;
      switch (handle) {
        case "p1":
          next = { ...start, x: start.x + dx, y: start.y + dy };
          break;
        case "p2":
          next = { ...start, x2: (start.x2 ?? 0) + dx, y2: (start.y2 ?? 0) + dy };
          break;
        case "resize":
          next = {
            ...start,
            w: Math.max(0.02, (start.w ?? 0) + dx),
            h: Math.max(0.02, (start.h ?? 0) + dy),
          };
          break;
        default:
          next = isArrow(start)
            ? {
                ...start,
                x: start.x + dx,
                y: start.y + dy,
                x2: (start.x2 ?? 0) + dx,
                y2: (start.y2 ?? 0) + dy,
              }
            : { ...start, x: start.x + dx, y: start.y + dy };
      }
      updateAnnotation(trackId, clip.id, clampAnno(next));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDragging(null);
      useStudio.getState().commitTransient();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (v: number) => `${v * 100}%`;
  const dot = "absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-brand shadow";

  return (
    <div
      ref={boxRef}
      data-anno-stage
      className={cn(
        "relative w-full select-none overflow-hidden rounded-md border hairline bg-black/60",
        dragging && "cursor-grabbing"
      )}
      style={{ aspectRatio: `${canvas.width} / ${canvas.height}` }}
    >
      {under?.thumbnail && (
        <img
          src={mediaUrl(under.thumbnail, under.createdAt)}
          alt=""
          className="pointer-events-none absolute inset-0 h-full w-full object-contain opacity-70"
        />
      )}

      <AnnotationLayer anno={anno} width={1} height={1} />

      {isArrow(anno) ? (
        <>
          {/* Grabbing the line itself moves the whole arrow; the ends aim it. */}
          <div
            onPointerDown={drag("move")}
            className="absolute inset-0 cursor-move"
            style={{ pointerEvents: "auto" }}
          />
          <span onPointerDown={drag("p1")} className={cn(dot, "cursor-grab")} style={{ left: pct(a.x), top: pct(a.y) }} />
          <span onPointerDown={drag("p2")} className={cn(dot, "cursor-grab")} style={{ left: pct(a.x2), top: pct(a.y2) }} />
        </>
      ) : (
        <div
          onPointerDown={drag("move")}
          className="absolute cursor-move"
          style={{ left: pct(box.x), top: pct(box.y), width: pct(box.w), height: pct(box.h) }}
        >
          {/* A keystroke badge has no corner to pull: its extent comes from the
              keys and the type size, so Size is the only thing to resize by. */}
          {anno.kind !== "keys" && (
            <span
              onPointerDown={drag("resize")}
              className={cn(dot, "cursor-nwse-resize")}
              style={{ left: "100%", top: "100%" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
