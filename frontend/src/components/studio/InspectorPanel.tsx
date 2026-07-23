import { useEffect, useRef, useState } from "react";
import {
  ChevronRight,
  Trash2,
  Settings2,
  Scissors,
  Link2,
  Palette,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { ColorSwatch, Field, NumInput, Section, SliderRow, ToggleRow } from "./inspector-bits";
import { ZoomPanSection } from "./ZoomPanSection";
import { AnnotationInspector } from "./AnnotationInspector";
import { RedactSection } from "./RedactSection";
import { ChromaSection } from "./ChromaSection";
import { DeviceSection } from "./DeviceSection";
import { BackdropSection } from "./BackdropSection";
import { SilenceSection } from "./SilenceSection";
import { BubbleSection } from "./BubbleSection";
import { IdleSection } from "./IdleSection";
import { ChaptersSection } from "./ChaptersSection";
import { StylePresetsSection } from "./StylePresetsSection";
import { MarkersSection } from "./MarkersSection";
import { ParamControl } from "./LeftRail";
import { PluginDocEditor } from "./PluginDocEditor";
import { useStudio } from "../../state";
import type {
  Asset,
  CaptionCue,
  Clip,
  CursorFX,
  EditDoc,
  GeneratorStatus,
  Keyable,
  Watermark,
} from "../../types";
import { clipPlayDur, clipSrcDur, anchorFrac } from "../../types";
import { MOTION_PRESETS } from "../../motionPresets";
import { SMART_FOCUS_DEFAULTS, smartFocus, type SmartFocusOptions } from "../../smartFocus";
import { api } from "../../api";
import { useLivePreview, type LivePreview } from "../../useLivePreview";
import { toast } from "../../toast";
import { parseDoc, serializeDoc, type Doc } from "../../pluginDoc";
import { awaitJob } from "../../jobs";
import type { PreviewSpec } from "../../types";
import type { Selection } from "./selection";
import { findClip } from "./selection";
import {
  aspectOf,
  captionTrack,
  cueForClip,
  detachedAudioFor,
  fmtDur,
  fmtTC,
} from "./bridge";

// Easing curves the renderer + preview both understand (render.easeProgress).
const EASINGS = ["linear", "easeInOut", "easeInCubic", "easeOutCubic", "easeOutBack", "easeOutElastic", "springOut"];

// ───────────────────────────── Inspector ──────────────────────────────────

export function Inspector({ doc, selection, onSelect }: { doc: EditDoc; selection: Selection; onSelect: (s: Selection) => void }) {
  const removeClip = useStudio((s) => s.removeClip);
  const removeCue = useStudio((s) => s.removeCue);

  const clip = "clipId" in selection ? findClip(doc, selection.trackId, selection.clipId) : undefined;
  const trackId = "trackId" in selection ? selection.trackId : "";
  const cue = clip ? cueForClip(captionTrack(doc)?.cues, clip) : undefined;
  const soloCue = selection.kind === "cue" ? captionTrack(doc)?.cues?.find((c) => c.id === selection.cueId) : undefined;

  let title = "Project";
  let sub = "Global settings";
  if (selection.kind === "clip" && clip) {
    title = clip.title ? "Title clip" : clip.annotation ? "Callout" : "Clip";
    sub = `${fmtDur(clipPlayDur(clip))} · ${clip.title ? "text" : clip.annotation ? clip.annotation.kind : "media"}`;
  } else if (selection.kind === "lane" && clip) {
    const labels = { video: "Video", audio: "Audio", subtitle: "Subtitle" };
    title = `${labels[selection.lane]}`;
    sub = "Sub-lane";
  } else if (selection.kind === "overlay" && clip) {
    title = "Overlay";
    sub = "Global layer";
  } else if (selection.kind === "soundtrack") {
    title = "Soundtrack";
    sub = "Global layer";
  } else if (selection.kind === "cue" && soloCue) {
    title = "Caption cue";
    sub = `${soloCue.start.toFixed(1)}–${soloCue.end.toFixed(1)}s`;
  } else if (selection.kind === "marker") {
    const mk = doc.markers?.find((m) => m.id === selection.markerId);
    title = mk?.label || "Marker";
    sub = mk ? fmtTC(mk.t) : "Timeline marker";
  }

  const deletable = (selection.kind === "clip" || selection.kind === "lane" || selection.kind === "overlay") && clip;

  return (
    <aside className="scrollbar-thin flex min-h-0 flex-col overflow-y-auto border-l hairline bg-panel">
      <div className="flex items-center justify-between border-b hairline px-3 py-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold">{title}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>
        </div>
        <Settings2 className="h-4 w-4 text-muted-foreground" />
      </div>

      <div className="flex-1 space-y-1 p-3 pt-2">
        {selection.kind === "clip" && clip && !clip.title && !clip.annotation && <ClipInspector trackId={trackId} clip={clip} />}
        {selection.kind === "clip" && clip && clip.title && <TitleInspector trackId={trackId} clip={clip} />}
        {selection.kind === "clip" && clip && clip.annotation && <AnnotationInspector trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "video" && <ClipInspector trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "audio" && <AudioInspector doc={doc} trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "subtitle" && <SubtitleInspector clip={clip} cue={cue} />}
        {selection.kind === "overlay" && clip && <TitleInspector trackId={trackId} clip={clip} />}
        {selection.kind === "soundtrack" && <SoundtrackInspector doc={doc} trackId={trackId} />}
        {selection.kind === "cue" && soloCue && <SubtitleInspector cue={soloCue} />}
        {selection.kind === "marker" && (
          <MarkersSection doc={doc} markerId={selection.markerId} onDeleted={() => onSelect({ kind: "none" })} />
        )}
        {selection.kind === "none" && <ProjectInspector doc={doc} onSelectMarker={(id) => onSelect({ kind: "marker", markerId: id })} />}

        {(selection.kind === "clip" || selection.kind === "lane") && clip && <AdvancedFold projectId={doc.id} trackId={trackId} clip={clip} />}
      </div>

      {deletable && (
        <div className="border-t hairline p-3">
          <Button
            variant="ghost"
            onClick={() => {
              if (clip) removeClip(trackId, clip.id);
              onSelect({ kind: "none" });
            }}
            className="w-full justify-center gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Delete clip
          </Button>
        </div>
      )}

      {selection.kind === "cue" && soloCue && (
        <div className="border-t hairline p-3">
          <Button
            variant="ghost"
            onClick={() => {
              removeCue(soloCue.id);
              onSelect({ kind: "none" });
            }}
            className="w-full justify-center gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="h-4 w-4" /> Delete cue
          </Button>
        </div>
      )}
    </aside>
  );
}






// fillHoldToEnd extends a clip's freeze-frame so it reaches the furthest end of
// any OTHER clip in the project — i.e. covers trailing audio to the last sound.
function fillHoldToEnd(trackId: string, clip: Clip) {
  const d = useStudio.getState().doc;
  if (!d) return;
  let end = 0;
  for (const t of d.tracks) for (const c of t.clips ?? []) {
    if (c.id === clip.id) continue;
    end = Math.max(end, c.start + clipPlayDur(c));
  }
  const srcEnd = clip.start + clipSrcDur(clip);
  const hold = Math.max(0, +(end - srcEnd).toFixed(3));
  useStudio.getState().updateClip(trackId, clip.id, { hold: hold || undefined });
}

// PreviewPane shows the cheap render of the current document. It is deliberately
// explicit that a preview is not the finished clip — the generator's note says
// how it differs — so nobody ships something believing they saw the real thing.
function PreviewPane({ preview, spec }: { preview: LivePreview; spec?: PreviewSpec }) {
  if (!spec) {
    return (
      <div className="rounded-md border hairline bg-panel/50 px-2 py-1.5 text-[10px] text-muted-foreground">
        No preview for this generator — re-render to see changes.
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="relative overflow-hidden rounded-md border hairline bg-black">
        {preview.url ? (
          <video src={preview.url} controls loop className="block max-h-48 w-full" />
        ) : (
          <div className="grid h-24 place-items-center text-[10px] text-muted-foreground">
            {preview.rendering ? "Rendering preview…" : "Edit to preview"}
          </div>
        )}
        {preview.url && preview.rendering && (
          <div className="absolute right-1 top-1 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-white">
            updating…
          </div>
        )}
      </div>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>Preview{spec.note ? ` · ${spec.note}` : ""} — not the final render.</span>
        {preview.error && <span className="text-red-400">preview failed</span>}
      </div>
    </div>
  );
}

// LivePluginSection keeps a generated clip editable: it surfaces the plugin
// document that produced it, so properties can be changed and the clip
// re-rendered in place rather than regenerated as a new one.
//
// The editor is driven by the field schema the generator publishes, so every
// plugin — including ones added later — gets this with no code here. A generator
// with no schema still gets a raw document editor rather than nothing.
function LivePluginSection({ asset }: { asset: Asset }) {
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  useEffect(() => {
    api.generators().then(setGens).catch(() => setGens([]));
  }, []);
  const gen = gens.find((g) => g.id === asset.source);

  if (gen && asset.genInput !== undefined) return <PluginLiveEditor asset={asset} gen={gen} />;

  // Imported media with no source document. Say so: rendering nothing here looks
  // identical to a broken inspector, and the reason is actionable — a plugin can
  // ship a .studio.json sidecar and its clips arrive editable.
  if (asset.source && asset.source !== "import" && asset.source !== "library") return null;
  return (
    <Section label="Plugin">
      <div className="text-[10px] leading-relaxed text-muted-foreground">
        This clip was imported as finished media, so its properties can't be edited here —
        Studio never saw the document that produced it. Clips generated in Studio, or
        imported with a <code className="font-mono">.studio.json</code> sidecar, stay editable.
      </div>
    </Section>
  );
}

function PluginLiveEditor({ asset, gen }: { asset: Asset; gen: GeneratorStatus }) {
  const projectId = useStudio((s) => s.doc?.id) ?? "";
  const hasSchema = !!gen.fields?.length;

  const [doc, setDoc] = useState<Doc>(() => parseDoc(asset.genInput, gen.docRoot));
  const [raw, setRaw] = useState(() => asset.genInput ?? "");
  const [params, setParams] = useState<Record<string, string>>(() => ({ ...(asset.genParams ?? {}) }));
  const [busy, setBusy] = useState(false);
  const preview = useLivePreview(projectId, gen.id, `asset:${asset.id}`, !!gen.preview);

  // Ask for a cheap preview whenever the edit settles. The hook debounces and
  // supersedes, so this is safe to call on every change.
  useEffect(() => {
    preview.request(hasSchema ? serializeDoc(doc) : raw, params);
  }, [doc, raw, params]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-seed the draft when the committed provenance changes (i.e. after a
  // re-render replaces the asset). Doesn't fire while editing, since only our own
  // re-render mutates genInput.
  useEffect(() => {
    setDoc(parseDoc(asset.genInput, gen.docRoot));
    setRaw(asset.genInput ?? "");
    setParams({ ...(asset.genParams ?? {}) });
  }, [asset.id, asset.genInput]); // eslint-disable-line react-hooks/exhaustive-deps

  const rerender = async () => {
    // With a schema we re-serialize the edited document, which preserves any key
    // the schema doesn't describe. Without one the user edited the text directly.
    const input = hasSchema ? serializeDoc(doc) : raw;
    if (!input.trim()) {
      toast.error("The plugin document is empty.");
      return;
    }
    if (!hasSchema && gen.rawKind !== "text" && gen.rawKind !== "html") {
      try {
        JSON.parse(input);
      } catch (e) {
        toast.error(`Invalid JSON: ${(e as Error).message}`);
        return;
      }
    }
    setBusy(true);
    try {
      const { jobId } = await api.rerender(projectId, asset.id, input, params);
      const data = await awaitJob(jobId);
      let next: Asset | null = (data?.asset as Asset) ?? null;
      // The SSE terminal event can be missed, in which case awaitJob resolves via
      // its poll fallback with a null payload. The backend has already replaced the
      // asset in place, so re-fetch and pull it by id — re-render must reliably
      // REPLACE the existing clip's asset, never silently no-op (which looks like
      // "it didn't work" and tempts a re-generate that adds a duplicate clip).
      if (!next) {
        try {
          const fresh = await api.getProject(projectId);
          next = fresh.assets.find((a) => a.id === asset.id) ?? null;
        } catch {
          /* leave next null */
        }
      }
      if (next) useStudio.getState().updateAsset(next);
      preview.clear(); // the clip itself is now up to date
      toast.success(`Re-rendered ${gen.name} clip.`);
    } catch (e) {
      toast.error(`Re-render failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section label={`${gen.name} · live`}>
      <div className="text-[10px] leading-relaxed text-muted-foreground">
        Edit the properties that generated this clip, then re-render it in place.
      </div>

      <PreviewPane preview={preview} spec={gen.preview} />

      {hasSchema ? (
        <PluginDocEditor fields={gen.fields!} doc={doc} onChange={setDoc} />
      ) : (
        <Textarea
          className="h-40 resize-y font-mono text-[11px]"
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          spellCheck={false}
        />
      )}

      {!!gen.params.length && (
        <div className="space-y-1 border-t hairline pt-2">
          {gen.params.map((spec) => (
            <ParamControl
              key={spec.flag}
              spec={spec}
              value={params[spec.flag] ?? spec.default ?? ""}
              onChange={(v) => setParams((p) => ({ ...p, [spec.flag]: v }))}
            />
          ))}
        </div>
      )}

      <button
        onClick={rerender}
        disabled={busy}
        className="w-full rounded-md bg-brand px-3 py-1.5 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Re-rendering…" : "Re-render clip"}
      </button>
    </Section>
  );
}

function ClipInspector({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const updateEffect = useStudio((s) => s.updateEffect);
  const resetEffects = useStudio((s) => s.resetEffects);
  const asset = useStudio((s) => s.doc?.assets.find((a) => a.id === clip.assetId));
  const tr = clip.transform;
  const setTr = (patch: Partial<Clip["transform"]>) => updateClip(trackId, clip.id, { transform: { ...tr, ...patch } });
  const eff = clip.effects ?? {};
  const tIn = clip.transitionIn?.type || "none";

  return (
    <>
      {asset && <LivePluginSection asset={asset} />}
      <Section label="Transform">
        <div className="grid grid-cols-2 gap-2">
          <Field label="X"><NumInput value={tr.x} step={5} suffix="px" onChange={(v) => setTr({ x: v })} /></Field>
          <Field label="Y"><NumInput value={tr.y} step={5} suffix="px" onChange={(v) => setTr({ y: v })} /></Field>
        </div>
        <SliderRow label="Scale" value={Math.round(tr.scale * 100)} min={10} max={300} step={1} onChange={(v) => setTr({ scale: v / 100 })} fmt={(v) => `${v}%`} />
        <SliderRow label="Rotate" value={tr.rotation || 0} min={-180} max={180} step={1} onChange={(v) => setTr({ rotation: v })} fmt={(v) => `${v}°`} />
        <SliderRow label="Opacity" value={Math.round(tr.opacity * 100)} min={0} max={100} step={1} onChange={(v) => setTr({ opacity: v / 100 })} fmt={(v) => `${v}%`} />
        <AnchorPicker tr={tr} onChange={setTr} />
      </Section>

      {asset && asset.kind !== "audio" && <StylePresetsSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.kind !== "audio" && <ZoomPanSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.kind !== "audio" && <RedactSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.kind !== "audio" && <ChromaSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.kind !== "image" && <SilenceSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.hasCursor && <IdleSection trackId={trackId} clip={clip} asset={asset} />}
      {asset && asset.kind !== "audio" && <BackdropSection trackId={trackId} clip={clip} />}
      {asset && asset.kind === "video" && <BubbleSection trackId={trackId} clip={clip} />}
      {asset && asset.kind !== "audio" && <DeviceSection trackId={trackId} clip={clip} />}
      {asset?.hasCursor && <SmartFocusSection trackId={trackId} clip={clip} assetId={asset.id} />}
      {asset?.hasCursor && (
        <CursorFXSection trackId={trackId} clip={clip} ownsCursor={!!asset.cursorHidden} />
      )}

      {asset && asset.kind !== "audio" && (
        <Section label="Motion blur" defaultOpen={false}>
          <SliderRow
            label="Strength"
            value={Math.round((clip.motionBlur ?? 0) * 100)}
            min={0}
            max={100}
            onChange={(v) => updateClip(trackId, clip.id, { motionBlur: v > 0 ? v / 100 : undefined })}
            fmt={(v) => `${v}%`}
          />
          <div className="text-[10px] text-muted-foreground">
            Smooths zoom and pan keyframes on export. Preview is a rough hint.
          </div>
        </Section>
      )}

      <KeyframeEditor trackId={trackId} clip={clip} />

      <Section label="Timing">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start"><NumInput value={clip.start} step={0.1} suffix="s" min={0} onChange={(v) => updateClip(trackId, clip.id, { start: v })} /></Field>
          <Field label="Speed"><NumInput value={clip.speed ?? 1} step={0.1} suffix="×" min={0.1} onChange={(v) => updateClip(trackId, clip.id, { speed: v })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Trim in"><NumInput value={clip.in} step={0.1} suffix="s" min={0} onChange={(v) => updateClip(trackId, clip.id, { in: v })} /></Field>
          <Field label="Trim out"><NumInput value={clip.out} step={0.1} suffix="s" min={0} onChange={(v) => updateClip(trackId, clip.id, { out: v })} /></Field>
        </div>
        {!clip.title && (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Freeze end"><NumInput value={clip.hold ?? 0} step={0.5} suffix="s" min={0} onChange={(v) => updateClip(trackId, clip.id, { hold: v || undefined })} /></Field>
              <div className="flex items-end">
                <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={() => fillHoldToEnd(trackId, clip)}>Extend to end</Button>
              </div>
            </div>
            <div className="text-[10px] text-muted-foreground">Holds the last frame after the clip ends — fills trailing audio instead of cutting to black.</div>
            {(clip.hold ?? 0) > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 w-full text-xs"
                title="Put the playhead where the freeze begins — then add a voiceover from Media and it lands right here."
                onClick={() => useStudio.getState().setPlayhead(+(clip.start + clipSrcDur(clip)).toFixed(3))}
              >
                Playhead → freeze start
              </Button>
            )}
          </>
        )}
      </Section>

      <Section label="Transition" defaultOpen={false}>
        <Field label="Type">
          <Select value={tIn} onValueChange={(v) => updateClip(trackId, clip.id, { transitionIn: v === "none" ? undefined : { type: v, duration: clip.transitionIn?.duration || 0.35 } })}>
            <SelectTrigger className="h-7 bg-panel-2 text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="fade">Fade</SelectItem>
              <SelectItem value="dissolve">Dissolve</SelectItem>
              <SelectItem value="slide-left">Slide ← left</SelectItem>
              <SelectItem value="slide-right">Slide → right</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {tIn !== "none" && (
          <Field label="Duration"><NumInput value={clip.transitionIn?.duration ?? 0.35} step={0.1} min={0.1} suffix="s" onChange={(v) => updateClip(trackId, clip.id, { transitionIn: { type: tIn, duration: v } })} /></Field>
        )}
      </Section>

      <Section label="Fades" defaultOpen={false}>
        <Field label="Fade in"><NumInput value={clip.fadeIn ?? 0} step={0.1} min={0} suffix="s" onChange={(v) => updateClip(trackId, clip.id, { fadeIn: v })} /></Field>
        <Field label="Fade out"><NumInput value={clip.fadeOut ?? 0} step={0.1} min={0} suffix="s" onChange={(v) => updateClip(trackId, clip.id, { fadeOut: v })} /></Field>
      </Section>

      <Section label="Effects" defaultOpen={false}>
        <SliderRow label="Bright" value={Math.round((eff.brightness ?? 0) * 100)} min={-100} max={100} onChange={(v) => updateEffect(trackId, clip.id, "brightness", v / 100)} />
        <SliderRow label="Contrast" value={Math.round((eff.contrast ?? 1) * 100)} min={0} max={200} onChange={(v) => updateEffect(trackId, clip.id, "contrast", v / 100)} />
        <SliderRow label="Sat" value={Math.round((eff.saturation ?? 1) * 100)} min={0} max={300} onChange={(v) => updateEffect(trackId, clip.id, "saturation", v / 100)} />
        <SliderRow label="Hue" value={eff.hue ?? 0} min={-180} max={180} onChange={(v) => updateEffect(trackId, clip.id, "hue", v)} />
        <SliderRow label="Blur" value={eff.blur ?? 0} min={0} max={30} step={0.5} onChange={(v) => updateEffect(trackId, clip.id, "blur", v)} />
        <button onClick={() => resetEffects(trackId, clip.id)} className="text-[10px] text-muted-foreground hover:text-foreground">reset effects</button>
      </Section>
    </>
  );
}

// SmartFocusSection derives zoom keyframes from where the user was working.
//
// It writes ordinary keyframes rather than a live effect, so every zoom it
// guesses lands on the timeline as diamonds you can drag, retime or delete.
// The one zoom it gets wrong is the one you most need to fix.
function SmartFocusSection({ trackId, clip, assetId }: { trackId: string; clip: Clip; assetId: string }) {
  const projectId = useStudio((s) => s.doc?.id ?? "");
  const canvas = useStudio((s) => s.doc?.canvas);
  const updateClip = useStudio((s) => s.updateClip);
  const [opts, setOpts] = useState<SmartFocusOptions>(SMART_FOCUS_DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<number | null>(null);
  const set = (patch: Partial<SmartFocusOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const apply = async (preview: boolean) => {
    if (!canvas) return;
    setBusy(true);
    try {
      const { track } = await api.cursorTrack(projectId, assetId);
      if (!track) {
        toast.error("No pointer track on this clip.");
        return;
      }
      const { keyframes, segments } = smartFocus(
        track as never,
        clipPlayDur(clip),
        { width: canvas.width, height: canvas.height },
        opts
      );
      setFound(segments.length);
      if (!segments.length) {
        toast.info("No clicks or dwells found to zoom on — try a lower dwell time.");
        return;
      }
      if (preview) {
        toast.info(`${segments.length} zoom${segments.length > 1 ? "s" : ""} found.`);
        return;
      }
      // Replaces only the properties focus drives, so a hand-built opacity fade
      // or rotation survives.
      const merged = { ...(clip.keyframes ?? {}), ...keyframes };
      updateClip(trackId, clip.id, { keyframes: merged });
      toast.success(`${segments.length} zoom${segments.length > 1 ? "s" : ""} → timeline`);
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const clearFocus = () => {
    const kf = { ...(clip.keyframes ?? {}) };
    delete kf.scale;
    delete kf.x;
    delete kf.y;
    updateClip(trackId, clip.id, { keyframes: Object.keys(kf).length ? kf : undefined });
    setFound(null);
    toast.success("Zoom keyframes cleared");
  };

  return (
    <Section label="Auto zoom" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        Finds where you clicked and paused, and zooms there. Writes normal keyframes —
        edit or delete any of them afterwards.
      </div>

      <SliderRow
        label="Zoom" value={Math.round(opts.zoom * 100)} min={110} max={300} step={5}
        onChange={(v) => set({ zoom: v / 100 })} fmt={(v) => `${(v / 100).toFixed(2)}×`}
      />
      <SliderRow
        label="Move time" value={Math.round(opts.ramp * 100)} min={20} max={200} step={5}
        onChange={(v) => set({ ramp: v / 100 })} fmt={(v) => `${(v / 100).toFixed(2)}s`}
      />
      <SliderRow
        label="Min hold" value={Math.round(opts.minHold * 100)} min={40} max={500} step={10}
        onChange={(v) => set({ minHold: v / 100 })} fmt={(v) => `${(v / 100).toFixed(1)}s`}
      />

      <ToggleRow
        label="Zoom on clicks" hint="Each press is a place something happened."
        checked={opts.useClicks} onChange={(v) => set({ useClicks: v })}
      />
      <ToggleRow
        label="Zoom on pauses" hint="A parked pointer is usually pointing at something."
        checked={opts.useDwell} onChange={(v) => set({ useDwell: v })}
      />
      {opts.useDwell && (
        <div className="pl-5">
          <SliderRow
            label="Pause length" value={Math.round(opts.dwellTime * 10)} min={3} max={50} step={1}
            onChange={(v) => set({ dwellTime: v / 10 })} fmt={(v) => `${(v / 10).toFixed(1)}s`}
          />
        </div>
      )}
      <SliderRow
        label="Group within" value={Math.round(opts.clusterGap * 10)} min={5} max={100} step={5}
        onChange={(v) => set({ clusterGap: v / 10 })} fmt={(v) => `${(v / 10).toFixed(1)}s`}
      />
      <div className="text-[10px] leading-relaxed text-muted-foreground">
        Actions closer together than this become one zoom instead of several.
      </div>

      <div className="flex gap-1.5 pt-1">
        <Button
          size="sm" variant="ghost" disabled={busy}
          className="h-7 flex-1 bg-panel-3 text-xs"
          onClick={() => void apply(true)}
        >
          {busy ? "…" : found !== null ? `${found} found` : "Analyze"}
        </Button>
        <Button
          size="sm" disabled={busy}
          className="h-7 flex-1 bg-brand text-xs text-brand-foreground hover:bg-brand/90"
          onClick={() => void apply(false)}
        >
          Apply zooms
        </Button>
      </div>
      <Button
        size="sm" variant="ghost"
        className="h-6 w-full text-[10px] text-muted-foreground"
        onClick={clearFocus}
      >
        Clear zoom keyframes
      </Button>
    </Section>
  );
}

// CursorFXSection emphasises the pointer on a screen recording. Only shown when
// the asset actually arrived with a pointer track, since without one every
// control here is inert — the renderer would silently skip them all.
function CursorFXSection({ trackId, clip, ownsCursor }: { trackId: string; clip: Clip; ownsCursor: boolean }) {
  const updateClip = useStudio((s) => s.updateClip);
  const fx = clip.cursor ?? {};
  const set = (patch: Partial<CursorFX>) =>
    updateClip(trackId, clip.id, { cursor: { ...fx, ...patch } });
  // Toggling an effect on writes an empty object; the renderer fills in
  // defaults, so "on" needs no opinion about values here.
  const toggle = (key: keyof CursorFX, on: boolean) =>
    set({ [key]: on ? (fx[key] ?? {}) : undefined } as Partial<CursorFX>);

  return (
    <Section label="Cursor effects" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        This clip has a recorded pointer track. Effects are drawn on export.
      </div>

      {ownsCursor ? (
        <>
          <ToggleRow
            label="Draw the cursor"
            hint="This recording was captured without one, so Studio draws it — resize, restyle and smooth it freely."
            checked={!!fx.pointer}
            onChange={(v) => toggle("pointer", v)}
          />
          {fx.pointer && (
            <div className="space-y-1 pl-5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Style</span>
                <select
                  value={fx.pointer.style ?? "arrow"}
                  onChange={(e) => set({ pointer: { ...fx.pointer, style: e.target.value } })}
                  className="h-6 flex-1 rounded border hairline bg-panel px-1 text-[10px] outline-none"
                >
                  <option value="arrow">Arrow</option>
                  <option value="dot">Dot</option>
                  <option value="ring">Ring</option>
                </select>
              </div>
              <SliderRow
                label="Size" value={fx.pointer.size ?? 44} min={16} max={160} step={2}
                onChange={(v) => set({ pointer: { ...fx.pointer, size: v } })} fmt={(v) => `${v}px`}
              />
              <SliderRow
                label="Opacity" value={Math.round((fx.pointer.opacity ?? 1) * 100)} min={20} max={100} step={5}
                onChange={(v) => set({ pointer: { ...fx.pointer, opacity: v / 100 } })} fmt={(v) => `${v}%`}
              />
              <SliderRow
                label="Smoothing" value={Math.round((fx.pointer.smoothing ?? 0) * 100)} min={0} max={100} step={5}
                onChange={(v) => set({ pointer: { ...fx.pointer, smoothing: v / 100 } })}
                fmt={(v) => (v === 0 ? "off" : `${v}%`)}
              />
              <ColorRow
                label="Color" value={fx.pointer.color ?? "#ffffff"}
                onChange={(v) => set({ pointer: { ...fx.pointer, color: v } })}
              />
              <div className="text-[10px] leading-relaxed text-muted-foreground">
                Smoothing irons out hand shake. Clicks stay pinned to where they actually landed.
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="rounded border hairline bg-panel-2/60 px-2 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
          The cursor is part of this recording's pixels, so it can't be resized, restyled or
          smoothed. Enable <span className="text-foreground">Studio draws the cursor</span> before
          recording to make it editable.
        </div>
      )}

      <ToggleRow
        label="Highlight"
        hint="A soft disc that follows the pointer."
        checked={!!fx.highlight}
        onChange={(v) => toggle("highlight", v)}
      />
      {fx.highlight && (
        <div className="space-y-1 pl-5">
          <SliderRow
            label="Size" value={fx.highlight.size ?? 96} min={32} max={300} step={4}
            onChange={(v) => set({ highlight: { ...fx.highlight, size: v } })} fmt={(v) => `${v}px`}
          />
          <SliderRow
            label="Opacity" value={Math.round((fx.highlight.opacity ?? 0.35) * 100)} min={5} max={100} step={5}
            onChange={(v) => set({ highlight: { ...fx.highlight, opacity: v / 100 } })} fmt={(v) => `${v}%`}
          />
          <ColorRow
            label="Color" value={fx.highlight.color ?? "#ffcc33"}
            onChange={(v) => set({ highlight: { ...fx.highlight, color: v } })}
          />
        </div>
      )}

      <ToggleRow
        label="Click rings"
        hint="A ring expands where each click happened."
        checked={!!fx.clicks}
        onChange={(v) => toggle("clicks", v)}
      />
      {fx.clicks && (
        <div className="space-y-1 pl-5">
          <SliderRow
            label="Size" value={fx.clicks.size ?? 140} min={40} max={400} step={10}
            onChange={(v) => set({ clicks: { ...fx.clicks, size: v } })} fmt={(v) => `${v}px`}
          />
          <SliderRow
            label="Length" value={Math.round((fx.clicks.duration ?? 0.45) * 100)} min={15} max={150} step={5}
            onChange={(v) => set({ clicks: { ...fx.clicks, duration: v / 100 } })} fmt={(v) => `${(v / 100).toFixed(2)}s`}
          />
          <ColorRow
            label="Color" value={fx.clicks.color ?? "#ffffff"}
            onChange={(v) => set({ clicks: { ...fx.clicks, color: v } })}
          />
        </div>
      )}

      <ToggleRow
        label="Click sounds"
        hint="A synthesised click at each press. Mixed on export; the preview plays it while scrubbing."
        checked={!!fx.sound}
        onChange={(v) => toggle("sound", v)}
      />
      {fx.sound && (
        <div className="space-y-1 pl-5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Style</span>
            <select
              value={fx.sound.style ?? "click"}
              onChange={(e) => set({ sound: { ...fx.sound, style: e.target.value } })}
              className="h-6 flex-1 rounded border hairline bg-panel px-1 text-[10px] outline-none"
            >
              <option value="click">Click</option>
              <option value="tick">Tick</option>
              <option value="soft">Soft</option>
            </select>
          </div>
          <SliderRow
            label="Volume" value={Math.round((fx.sound.volume ?? 0.35) * 100)} min={5} max={100} step={5}
            onChange={(v) => set({ sound: { ...fx.sound, volume: v / 100 } })} fmt={(v) => `${v}%`}
          />
        </div>
      )}

      <ToggleRow
        label="Spotlight"
        hint="Dims everything except a radius around the pointer."
        checked={!!fx.spotlight}
        onChange={(v) => toggle("spotlight", v)}
      />
      {fx.spotlight && (
        <div className="space-y-1 pl-5">
          <SliderRow
            label="Radius" value={fx.spotlight.radius ?? 220} min={80} max={800} step={10}
            onChange={(v) => set({ spotlight: { ...fx.spotlight, radius: v } })} fmt={(v) => `${v}px`}
          />
          <SliderRow
            label="Dim" value={Math.round((fx.spotlight.dim ?? 0.55) * 100)} min={10} max={95} step={5}
            onChange={(v) => set({ spotlight: { ...fx.spotlight, dim: v / 100 } })} fmt={(v) => `${v}%`}
          />
        </div>
      )}

      <div className="text-[10px] leading-relaxed text-muted-foreground">
        The canvas preview doesn't draw these — use Export ▸ Render frame to see them.
      </div>
    </Section>
  );
}

function ColorRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-12 cursor-pointer rounded border hairline bg-panel"
      />
    </div>
  );
}

// AnchorPicker sets the zoom origin — the point a scale animation holds fixed.
// Dragging it onto a UI element is what turns a generic zoom into "zoom into
// THAT". Stored center-relative (0 = center), so the pad's middle is the default.
function AnchorPicker({ tr, onChange }: { tr: Clip["transform"]; onChange: (p: Partial<Clip["transform"]>) => void }) {
  const padRef = useRef<HTMLDivElement>(null);
  const [ax, ay] = anchorFrac(tr);
  const centered = !tr.anchorX && !tr.anchorY;

  const setFromEvent = (e: { clientX: number; clientY: number }) => {
    const r = padRef.current?.getBoundingClientRect();
    if (!r || !r.width || !r.height) return;
    const fx = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const fy = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
    onChange({ anchorX: +(fx - 0.5).toFixed(4), anchorY: +(fy - 0.5).toFixed(4) });
  };

  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    setFromEvent(e);
    const move = (ev: PointerEvent) => setFromEvent(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Anchor</span>
        <button
          onClick={() => onChange({ anchorX: undefined, anchorY: undefined })}
          disabled={centered}
          className="text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
        >
          {centered ? "centered" : "reset"}
        </button>
      </div>
      <div
        ref={padRef}
        onPointerDown={drag}
        title="Drag to set the zoom origin"
        className="relative aspect-video w-full cursor-crosshair rounded border hairline bg-panel-2"
      >
        {/* center guides, so "back to the middle" is findable by eye */}
        <div className="pointer-events-none absolute inset-x-0 top-1/2 border-t hairline opacity-40" />
        <div className="pointer-events-none absolute inset-y-0 left-1/2 border-l hairline opacity-40" />
        <div
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-brand bg-background"
          style={{ left: `${ax * 100}%`, top: `${ay * 100}%` }}
        />
      </div>
    </div>
  );
}

function KeyframeEditor({ trackId, clip }: { trackId: string; clip: Clip }) {
  const addKeyframe = useStudio((s) => s.addKeyframe);
  const updateKeyframe = useStudio((s) => s.updateKeyframe);
  const setKeyframeEase = useStudio((s) => s.setKeyframeEase);
  const removeKeyframe = useStudio((s) => s.removeKeyframe);
  const applyMotionPreset = useStudio((s) => s.applyMotionPreset);
  const playhead = useStudio((s) => s.playhead);
  const props: { k: Keyable; label: string }[] = [
    { k: "x", label: "X" },
    { k: "y", label: "Y" },
    { k: "scale", label: "Scale" },
    { k: "rotation", label: "Rotate" },
    { k: "opacity", label: "Opacity" },
  ];
  const localT = Math.max(0, +(playhead - clip.start).toFixed(2));

  return (
    <Section label="Motion keyframes" defaultOpen={false}>
      <div className="text-[10.5px] leading-relaxed text-muted-foreground">
        Set a Transform value, move the playhead, then key it. Playhead t = {localT}s (clip-local).
      </div>
      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Camera move</div>
        <div className="grid grid-cols-2 gap-1">
          {MOTION_PRESETS.map((p) => (
            <button
              key={p.id}
              title={p.hint}
              onClick={() => {
                applyMotionPreset(trackId, clip.id, p.id);
                toast.success(`${p.label} applied`);
              }}
              className="rounded border hairline bg-panel-2 px-1.5 py-1 text-[10.5px] hover:bg-panel-3"
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
          Zooms scale about the anchor — drop it on what you're emphasizing first.
        </div>
      </div>
      {props.map(({ k, label }) => {
        const keys = clip.keyframes?.[k] ?? [];
        return (
          <div key={k} className="rounded-md bg-panel-2/50 p-1.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium">{label}</span>
              <button
                onClick={() => addKeyframe(trackId, clip.id, k)}
                title={`Key ${label} at the playhead`}
                className="rounded bg-panel-3 px-1.5 py-0.5 text-[10px] text-brand hover:text-foreground"
              >
                ◆ key
              </button>
            </div>
            {keys.length === 0 ? (
              <div className="mt-0.5 text-[10px] text-muted-foreground">no keys</div>
            ) : (
              <div className="mt-1 space-y-1">
                {keys.map((kf, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <span className="w-9 shrink-0 text-[10px] tabular text-muted-foreground">{kf.t.toFixed(2)}s</span>
                    <input
                      defaultValue={String(kf.value)}
                      onBlur={(e) => updateKeyframe(trackId, clip.id, k, i, parseFloat(e.target.value) || 0)}
                      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                      className="h-6 w-12 rounded border hairline bg-panel px-1 text-[11px] tabular outline-none focus:border-brand/50"
                    />
                    {i < keys.length - 1 && (
                      <select
                        value={kf.ease || "linear"}
                        onChange={(e) => setKeyframeEase(trackId, clip.id, k, i, e.target.value)}
                        className="h-6 flex-1 rounded border hairline bg-panel px-1 text-[10px] outline-none"
                      >
                        {EASINGS.map((ez) => (
                          <option key={ez} value={ez}>{ez}</option>
                        ))}
                      </select>
                    )}
                    <button
                      onClick={() => removeKeyframe(trackId, clip.id, k, i)}
                      className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground hover:text-destructive"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function AudioInspector({ doc, trackId, clip }: { doc: EditDoc; trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const detachAudio = useStudio((s) => s.detachAudio);
  const attachAudio = useStudio((s) => s.attachAudio);
  const det = detachedAudioFor(doc, clip.id);
  const tId = det ? det.trackId : trackId;
  const target = det ? det.clip : clip;
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const noAudio = asset?.hasAudio === false;

  return (
    <>
      <Section label="Audio">
        {det && <div className="rounded-md bg-brand-soft px-2 py-1 text-[11px] text-brand">Detached to its own mp3 lane — edits here affect that clip.</div>}
        {/* Start places the clip on the timeline — set it to the video's freeze
            point so a voiceover plays after the clip instead of over it. */}
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start"><NumInput value={target.start} step={0.1} min={0} suffix="s" onChange={(v) => updateClip(tId, target.id, { start: Math.max(0, v) })} /></Field>
          <div className="flex items-end">
            <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={() => updateClip(tId, target.id, { start: +Math.max(0, useStudio.getState().playhead).toFixed(3) })}>At playhead</Button>
          </div>
        </div>
        <SliderRow label="Volume" value={Math.round((target.volume ?? 1) * 100)} min={0} max={200} onChange={(v) => updateClip(tId, target.id, { volume: v / 100 })} fmt={(v) => `${v}%`} />
        <Field label="Fade in"><NumInput value={target.fadeIn ?? 0} step={0.1} min={0} suffix="s" onChange={(v) => updateClip(tId, target.id, { fadeIn: v })} /></Field>
        <Field label="Fade out"><NumInput value={target.fadeOut ?? 0} step={0.1} min={0} suffix="s" onChange={(v) => updateClip(tId, target.id, { fadeOut: v })} /></Field>
      </Section>
      <Section label="Source">
        {det ? (
          <Button size="sm" variant="ghost" className="h-7 w-full text-xs" onClick={() => attachAudio(trackId, clip.id)}>
            <Link2 className="mr-1 h-3.5 w-3.5" /> Re-embed audio into clip
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              className="h-7 w-full bg-panel-3 text-xs disabled:opacity-40"
              disabled={noAudio || !!clip.title}
              onClick={() => detachAudio(trackId, clip.id)}
            >
              <Scissors className="mr-1 h-3.5 w-3.5" /> {noAudio ? "No audio to detach" : "Detach audio → mp3 lane"}
            </Button>
            <div className="grid grid-cols-2 gap-1.5">
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateClip(trackId, clip.id, { mute: true })}>Mute</Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => updateClip(trackId, clip.id, { mute: false })}>Unmute</Button>
            </div>
          </>
        )}
      </Section>
    </>
  );
}

function SubtitleInspector({ clip, cue }: { clip?: Clip; cue?: CaptionCue }) {
  const updateCue = useStudio((s) => s.updateCue);
  const addCue = useStudio((s) => s.addCue);
  const setPlayhead = useStudio((s) => s.setPlayhead);

  if (!cue) {
    return (
      <Section label="Subtitle">
        <div className="text-[11px] text-muted-foreground">{clip ? "No caption overlaps this clip." : "No caption selected."}</div>
        {clip && (
          <Button
            size="sm"
            className="h-7 w-full bg-panel-3 text-xs"
            onClick={() => {
              setPlayhead(clip.start + 0.1);
              addCue();
            }}
          >
            Add caption here
          </Button>
        )}
      </Section>
    );
  }
  const style = cue.style;
  return (
    <>
      <Section label="Text">
        <Textarea value={cue.text} onChange={(e) => updateCue(cue.id, { text: e.target.value })} className="min-h-[64px] resize-none bg-panel-2 text-[12px]" />
        <div className="grid grid-cols-2 gap-2">
          <Field label="Start"><NumInput value={cue.start} step={0.1} suffix="s" onChange={(v) => updateCue(cue.id, { start: v })} /></Field>
          <Field label="End"><NumInput value={cue.end} step={0.1} suffix="s" onChange={(v) => updateCue(cue.id, { end: v })} /></Field>
        </div>
      </Section>
      <Section label="Style">
        <SliderRow label="Size" value={style.size} min={10} max={120} onChange={(v) => updateCue(cue.id, { style: { ...style, size: v } })} />
        <Field label="Color"><ColorSwatch color={style.color} onChange={(c) => updateCue(cue.id, { style: { ...style, color: c } })} /></Field>
        <Field label="Align">
          <div className="grid grid-cols-3 gap-1 rounded-md bg-panel-2 p-0.5">
            {(["left", "center", "right"] as const).map((a) => (
              <button
                key={a}
                onClick={() => updateCue(cue.id, { style: { ...style, align: a } })}
                className={cn("rounded py-1 text-[11px] capitalize", style.align === a ? "bg-panel-3 text-foreground" : "text-muted-foreground")}
              >
                {a}
              </button>
            ))}
          </div>
        </Field>
        <SliderRow label="Y pos" value={Math.round(style.posY * 100)} min={0} max={100} onChange={(v) => updateCue(cue.id, { style: { ...style, posY: v / 100 } })} fmt={(v) => `${v}%`} />
        {style.background != null && (
          <Field label="Background"><ColorSwatch color={style.background} onChange={(c) => updateCue(cue.id, { style: { ...style, background: c } })} /></Field>
        )}
        {style.stroke != null && (
          <Field label="Stroke"><ColorSwatch color={style.stroke} onChange={(c) => updateCue(cue.id, { style: { ...style, stroke: c } })} /></Field>
        )}
      </Section>
    </>
  );
}

function TitleInspector({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateTitle = useStudio((s) => s.updateTitle);
  const updateClip = useStudio((s) => s.updateClip);
  const applyTitleAnim = useStudio((s) => s.applyTitleAnim);
  const applyTitleReveal = useStudio((s) => s.applyTitleReveal);
  const t = clip.title;
  if (!t) return null;
  return (
    <>
      <Section label="Text">
        <Input value={t.text} onChange={(e) => updateTitle(trackId, clip.id, { text: e.target.value })} className="h-8 bg-panel-2 text-[12px]" />
        <div className="grid grid-cols-2 gap-2">
          <SliderRow label="Size" value={t.size} min={12} max={220} onChange={(v) => updateTitle(trackId, clip.id, { size: v })} />
          <Field label="Color"><ColorSwatch color={t.color} onChange={(c) => updateTitle(trackId, clip.id, { color: c })} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Vert"><NumInput value={t.posY} step={0.02} min={0} max={1} onChange={(v) => updateTitle(trackId, clip.id, { posY: v })} /></Field>
          <Field label="Dur"><NumInput value={clip.out} step={0.5} min={0.5} suffix="s" onChange={(v) => updateClip(trackId, clip.id, { out: v })} /></Field>
        </div>
      </Section>
      <Section label="Motion">
        <Field label="Anim">
          <Select value={t.anim || "none"} onValueChange={(v) => applyTitleAnim(trackId, clip.id, v as any)}>
            <SelectTrigger className="h-7 bg-panel-2 text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="fade">Fade</SelectItem>
              <SelectItem value="fadeUp">Fade up</SelectItem>
              <SelectItem value="pop">Pop</SelectItem>
              <SelectItem value="slide">Slide</SelectItem>
              <SelectItem value="zoom">Zoom</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Reveal">
          <Select value={t.reveal || "none"} onValueChange={(v) => applyTitleReveal(trackId, clip.id, (v === "none" ? "" : v) as any)}>
            <SelectTrigger className="h-7 bg-panel-2 text-[12px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="typewriter">Typewriter</SelectItem>
              <SelectItem value="word">Word</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </Section>
    </>
  );
}

function SoundtrackInspector({ doc, trackId }: { doc: EditDoc; trackId: string }) {
  const toggleTrackFlag = useStudio((s) => s.toggleTrackFlag);
  const batchUpdateClips = useStudio((s) => s.batchUpdateClips);
  const track = doc.tracks.find((t) => t.id === trackId);
  const vol = Math.round(((track?.clips?.[0]?.volume ?? 1) as number) * 100);
  return (
    <Section label="Soundtrack">
      <SliderRow
        label="Volume"
        value={vol}
        min={0}
        max={200}
        onChange={(v) => {
          if (!track?.clips) return;
          batchUpdateClips(track.clips.map((c) => ({ trackId, clipId: c.id, patch: { volume: v / 100 } })));
        }}
        fmt={(v) => `${v}%`}
      />
      <div className="flex items-center justify-between rounded-md bg-panel-2 px-2 py-1.5">
        <span className="text-[12px]">Duck under voice</span>
        <Switch checked={!!track?.duck} onCheckedChange={() => toggleTrackFlag(trackId, "duck")} />
      </div>
    </Section>
  );
}

function ProjectInspector({ doc, onSelectMarker }: { doc: EditDoc; onSelectMarker?: (id: string) => void }) {
  const setBackground = useStudio((s) => s.setBackground);
  const mutate = useStudio((s) => s.mutate);
  const bgTrack = doc.tracks.find((t) => t.kind === "background");
  const bg = bgTrack?.backgroundColor || "#0c0d10";
  const bg2 = bgTrack?.backgroundColor2 || "";
  const wm = doc.watermark;
  const logos = doc.assets.filter((a) => a.kind === "image");
  const patchWM = (p: Partial<Watermark>) =>
    mutate((d) => {
      if (d.watermark) Object.assign(d.watermark, p);
    });
  return (
    <>
    <Section label="Project">
      <Field label="Aspect"><span className="text-[12px] text-muted-foreground tabular">{aspectOf(doc.canvas)}</span></Field>
      <Field label="BG"><ColorSwatch color={bg} onChange={(c) => setBackground(c, bg2 || undefined)} /></Field>
      <Field label="BG gradient">
        <div className="flex items-center gap-2">
          <ColorSwatch color={bg2 || "#6366f1"} onChange={(c) => setBackground(bg, c)} />
          {bg2 ? (
            <Button variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => setBackground(bg, "")}>
              Solid only
            </Button>
          ) : (
            <span className="text-[10px] text-muted-foreground">Pick to enable gradient</span>
          )}
        </div>
      </Field>
      <Field label="FPS">
        <Select value={String(doc.canvas.fps)} onValueChange={(v) => mutate((d) => { d.canvas.fps = parseInt(v, 10); })}>
          <SelectTrigger className="h-7 bg-panel-2 text-[12px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="24">24</SelectItem>
            <SelectItem value="30">30</SelectItem>
            <SelectItem value="60">60</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="Logo">
        <select
          value={wm?.assetId || ""}
          onChange={(e) =>
            mutate((d) => {
              d.watermark = e.target.value ? { ...(d.watermark ?? {}), assetId: e.target.value } : undefined;
            })
          }
          className="h-7 flex-1 rounded border hairline bg-panel px-1 text-[11px] outline-none"
        >
          <option value="">No watermark</option>
          {logos.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
      </Field>
      {wm && (
        <>
          <Field label="Corner">
            <div className="flex gap-1">
              {(["tl", "tr", "bl", "br"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => patchWM({ corner: c })}
                  className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${(wm.corner ?? "br") === c ? "bg-brand/90 text-white" : "bg-panel-3 text-muted-foreground hover:text-foreground"}`}
                >
                  {c}
                </button>
              ))}
            </div>
          </Field>
          <SliderRow
            label="Size"
            value={Math.round((wm.size || 0.12) * 100)}
            min={4}
            max={40}
            step={1}
            onChange={(v) => patchWM({ size: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <SliderRow
            label="Opacity"
            value={Math.round((wm.opacity || 0.6) * 100)}
            min={10}
            max={100}
            step={5}
            onChange={(v) => patchWM({ opacity: v / 100 })}
            fmt={(v) => `${v}%`}
          />
        </>
      )}
      {!logos.length && !wm && (
        <p className="px-1 text-[10px] text-muted-foreground">Import a PNG logo to the library to add a watermark.</p>
      )}
    </Section>
    <MarkersSection doc={doc} onSelectMarker={onSelectMarker} />
    </>
  );
}

function AdvancedFold({ projectId, trackId, clip }: { projectId: string; trackId: string; clip: Clip }) {
  const updateEQ = useStudio((s) => s.updateEQ);
  const updateClip = useStudio((s) => s.updateClip);
  const [open, setOpen] = useState(false);
  const [luts, setLuts] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const lutRef = useRef<HTMLInputElement>(null);
  const eq = clip.eq ?? {};

  useEffect(() => {
    if (!open) return;
    api.listLUTs(projectId).then((r) => setLuts(r.luts)).catch(() => {});
  }, [open, projectId]);

  const uploadLut = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const { name } = await api.uploadLUT(projectId, file);
      const r = await api.listLUTs(projectId);
      setLuts(r.luts);
      updateClip(trackId, clip.id, { lut: name });
    } catch (e) {
      toast.error("LUT upload failed: " + (e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="mt-2 rounded-lg border border-dashed border-hairline bg-panel-2/20">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-1.5 px-2.5 py-2 text-left">
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", open && "rotate-90")} />
        <span className="label-caps">Advanced</span>
        <span className="ml-auto text-[10px] text-muted-foreground">Pro</span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t hairline px-2.5 py-2.5">
          <div>
            <div className="label-caps mb-1.5">Audio EQ</div>
            <SliderRow label="Low" value={eq.low ?? 0} min={-12} max={12} step={0.5} onChange={(v) => updateEQ(trackId, clip.id, "low", v)} fmt={(v) => `${v}dB`} />
            <SliderRow label="Mid" value={eq.mid ?? 0} min={-12} max={12} step={0.5} onChange={(v) => updateEQ(trackId, clip.id, "mid", v)} fmt={(v) => `${v}dB`} />
            <SliderRow label="High" value={eq.high ?? 0} min={-12} max={12} step={0.5} onChange={(v) => updateEQ(trackId, clip.id, "high", v)} fmt={(v) => `${v}dB`} />
          </div>
          <div>
            <div className="label-caps mb-1.5">Noise removal</div>
            <SliderRow
              label="Strength"
              value={Math.round((clip.denoise ?? 0) * 100)}
              min={0}
              max={100}
              step={5}
              onChange={(v) => updateClip(trackId, clip.id, { denoise: v > 0 ? v / 100 : undefined })}
              fmt={(v) => (v > 0 ? `${v}%` : "off")}
            />
            <div className="mt-1 text-[10px] text-muted-foreground">Removes steady background noise (fans, hiss). Applies on export.</div>
          </div>
          <div>
            <div className="label-caps mb-1.5 flex items-center gap-1.5"><Palette className="h-3 w-3" /> Color LUT</div>
            <div className="flex items-center gap-1.5">
              <select
                value={clip.lut || ""}
                onChange={(e) => updateClip(trackId, clip.id, { lut: e.target.value || undefined })}
                className="h-7 flex-1 rounded border hairline bg-panel px-1 text-[11px] outline-none"
              >
                <option value="">None</option>
                {luts.map((l) => (
                  <option key={l} value={l}>{l}</option>
                ))}
              </select>
              <button onClick={() => lutRef.current?.click()} className="rounded bg-panel-3 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground">
                {uploading ? "…" : "upload .cube"}
              </button>
              <input
                ref={lutRef}
                type="file"
                accept=".cube"
                className="hidden"
                onChange={(e) => {
                  uploadLut(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">Grade applies on export — use "Render frame @ playhead" to preview it exactly.</div>
          </div>
        </div>
      )}
    </div>
  );
}
