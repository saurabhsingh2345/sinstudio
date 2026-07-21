import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Undo2,
  Redo2,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Plus,
  X,
  Import as ImportIcon,
  Library,
  Wand2,
  Type,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  Captions,
  Scissors,
  Copy,
  Link2,
  Music2,
  Image as ImageIcon,
  Sparkles,
  Layers,
  Trash2,
  Settings2,
  Circle,
  Square,
  RectangleHorizontal,
  RectangleVertical,
  GripVertical,
  Package,
  Palette,
  RotateCw,
  Moon,
  Sun,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useArcTheme } from "../arc/theme";
import { useStudio, projectDuration } from "../../state";
import type {
  AppStatus,
  Asset,
  CaptionCue,
  Clip,
  EditDoc,
  CursorFX,
  GeneratorStatus,
  Keyable,
  LibraryEntry,
  ParamSpec,
  PluginState,
  PreviewSpec,
  Track,
} from "../../types";
import { SAMPLES } from "../../generatorSamples";
import { anchorFrac, clipPlayDur, clipSrcDur, mediaUrl } from "../../types";
import { MOTION_PRESETS } from "../../motionPresets";
import { SMART_FOCUS_DEFAULTS, smartFocus, type SmartFocusOptions } from "../../smartFocus";
import {
  isRecordingSupported,
  listInputs,
  startRecording,
  type RecordKind,
  type RecordOptions,
  type RecordingHandle,
} from "../../recorder";
import {
  canMapToVideo,
  probeCursord,
  startCursorTracking,
  stopCursorTracking,
  toSidecar,
  type CursorHealth,
} from "../../cursor";
import { api } from "../../api";
import { PluginDocEditor } from "./PluginDocEditor";
import { parseDoc, seedDoc, serializeDoc, type Doc } from "../../pluginDoc";
import { useLivePreview, type LivePreview } from "../../useLivePreview";
import { toast } from "../../toast";
import { revealedText } from "../../titleAnim";
import { getPeaks } from "../../peaks";
import { getCursorTrack, cursorTrackNow } from "../../cursorTracks";
import { drawCursorFX } from "./cursor-draw";
import { awaitJob } from "../../jobs";
import { AppStudio } from "../AppStudio";
import { activeVisuals, activeAudios, clipBox, cssFilter, audioLevel } from "./preview-engine";
import { Timeline } from "./Timeline";
import type { LaneKind, Selection } from "./selection";
import { findClip } from "./selection";
import { ExportDialog } from "../ExportDialog";
import { RendersModal } from "../RendersModal";
import { LibraryModal } from "../LibraryModal";
import {
  ASPECT_CANVAS,
  aspectOf,
  captionTrack,
  clipEnd,
  cueForClip,
  detachedAudioFor,
  fmtDur,
  fmtTC,
  hueFor,
  primaryTrack,
  audioTracks as audioTracksOf,
  overlayTracks as overlayTracksOf,
  type AspectKey,
} from "./bridge";

// ───────────────────────────── Selection model ────────────────────────────
// Selection/LaneKind/findClip now live in ./selection so the Timeline can share
// them without a circular import.

const ASPECTS = {
  "9:16": { label: "9:16 · Vertical", Icon: RectangleVertical },
  "1:1": { label: "1:1 · Square", Icon: Square },
  "16:9": { label: "16:9 · Landscape", Icon: RectangleHorizontal },
} as const;

// Easing curves the renderer + preview both understand (render.easeProgress).
const EASINGS = ["linear", "easeInOut", "easeInCubic", "easeOutCubic", "easeOutBack", "easeOutElastic", "springOut"];

// ───────────────────────────── Studio root ────────────────────────────────

export function StudioView({ projectId, onHome }: { projectId: string; onHome?: () => void }) {
  const doc = useStudio((s) => s.doc);
  const load = useStudio((s) => s.load);
  const playing = useStudio((s) => s.playing);
  const setPlaying = useStudio((s) => s.setPlaying);
  const setPlayhead = useStudio((s) => s.setPlayhead);

  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showExport, setShowExport] = useState(false);
  const [showRenders, setShowRenders] = useState(false);

  // Shared with the Arc dashboard/wizard (localStorage `arc-theme`) so the whole
  // app stays on one theme. `dark` keeps the original editor palette; `light`
  // resolves the `.studio-light` tokens in tailwind.css.
  const [theme, toggleTheme] = useArcTheme();
  const themeClass = theme === "dark" ? "dark" : "studio-light";

  useEffect(() => {
    load(projectId).catch((e) => toast.error(String(e?.message || e)));
  }, [projectId, load]);

  const total = useMemo(() => projectDuration(doc), [doc]);

  // Playback clock — advance the playhead while playing, stop at the end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = useStudio.getState().playhead + dt;
      if (next >= total) {
        setPlayhead(total);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, setPlayhead, setPlaying]);

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const st = useStudio.getState();
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === "z") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); return; }
      if (meta && k === "y") { e.preventDefault(); st.redo(); return; }
      if (meta && k === "c") { st.copySelected(); return; }
      if (meta && k === "v") { st.paste(); return; }
      if (meta) return;
      if (e.code === "Space") { e.preventDefault(); st.setPlaying(!st.playing); return; }
      if (k === "s") { e.preventDefault(); st.splitAtPlayhead(); return; }
      if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); e.shiftKey ? st.rippleDelete() : st.deleteSelected(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); st.nudgePlayhead(e.shiftKey ? -1 : -1 / 30); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); st.nudgePlayhead(e.shiftKey ? 1 : 1 / 30); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the local selection valid as the doc changes; sync it to the store so
  // split/delete/keyboard actions target the same clip the Inspector shows.
  const syncStore = (s: Selection) => {
    const st = useStudio.getState();
    if (s.kind === "clip" || s.kind === "overlay") st.select(s.trackId, s.clipId);
    else if (s.kind === "lane" && s.lane !== "subtitle") st.select(s.trackId, s.clipId);
    else if (s.kind === "lane" && s.lane === "subtitle") {
      const cap = doc ? captionTrack(doc) : undefined;
      const clip = findClip(doc, s.trackId, s.clipId);
      const cue = clip ? cueForClip(cap?.cues, clip) : undefined;
      if (cue) st.selectCue(cue.id);
      else st.select(s.trackId, s.clipId);
    } else if (s.kind === "cue") st.selectCue(s.cueId);
    else st.selectCue(null);
  };
  const select = (s: Selection) => {
    setSelection(s);
    syncStore(s);
  };

  if (!doc) {
    return (
      <div className={`${themeClass} grid h-screen w-screen place-items-center bg-background text-muted-foreground`}>
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 animate-pulse text-brand" /> Loading project…
        </div>
      </div>
    );
  }

  const aspect = aspectOf(doc.canvas);

  return (
    <div className={`${themeClass} flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground`}>
      <TopBar
        doc={doc}
        aspect={aspect}
        theme={theme}
        onToggleTheme={toggleTheme}
        onHome={onHome}
        onExport={() => setShowExport(true)}
        onRenders={() => setShowRenders(true)}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_320px]">
        <LeftRail projectId={projectId} doc={doc} onSelect={select} />
        <CenterColumn
          doc={doc}
          aspect={aspect}
          selection={selection}
          expanded={expanded}
          onToggleExpand={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
          onSelect={select}
          total={total}
        />
        <Inspector doc={doc} selection={selection} onSelect={select} />
      </div>

      {showExport && (
        <div className="legacy">
          <ExportDialog projectId={projectId} onClose={() => setShowExport(false)} />
        </div>
      )}
      {showRenders && (
        <div className="legacy">
          <RendersModal projectId={projectId} onClose={() => setShowRenders(false)} />
        </div>
      )}
    </div>
  );
}

// ───────────────────────────── Top bar ────────────────────────────────────

function TopBar({
  doc,
  aspect,
  theme,
  onToggleTheme,
  onHome,
  onExport,
  onRenders,
}: {
  doc: EditDoc;
  aspect: AspectKey;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onHome?: () => void;
  onExport: () => void;
  onRenders: () => void;
}) {
  const saving = useStudio((s) => s.saving);
  const dirty = useStudio((s) => s.dirty);
  const conflict = useStudio((s) => s.conflict);
  const resolveConflict = useStudio((s) => s.resolveConflict);
  const undo = useStudio((s) => s.undo);
  const redo = useStudio((s) => s.redo);
  const mutate = useStudio((s) => s.mutate);
  const A = ASPECTS[aspect];

  const setAspect = (k: AspectKey) => {
    const { w, h } = ASPECT_CANVAS[k];
    mutate((d) => {
      d.canvas.width = w;
      d.canvas.height = h;
    });
  };

  const status = conflict ? "Conflict" : saving ? "Saving…" : dirty ? "Unsaved" : "Saved";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b hairline bg-panel/80 px-3 backdrop-blur">
      <button
        onClick={onHome}
        title="Back to projects"
        className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-panel-2 hover:text-foreground"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <div className="flex items-center gap-2">
        <div className="grid h-6 w-6 place-items-center rounded-md bg-gradient-to-br from-brand to-signal">
          <Sparkles className="h-3.5 w-3.5 text-white" />
        </div>
        <div className="text-sm font-medium">{doc.name}</div>
        <div className="ml-1 flex items-center gap-1.5 rounded-full border hairline bg-panel-2 px-2 py-0.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              conflict ? "bg-red-500" : saving ? "bg-amber-400" : dirty ? "bg-muted-foreground" : "bg-signal"
            )}
          />
          {status} · v{doc.version}
        </div>
      </div>

      {/* Someone else saved this project while it was open. Autosave has stopped
          rather than overwrite their work; the local doc is kept until the user
          chooses to discard it. */}
      {conflict && (
        <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1 text-[11px] text-red-200">
          <span>Someone else saved this project. Your changes are not being saved.</span>
          <button
            onClick={resolveConflict}
            className="rounded border border-red-400/50 px-1.5 py-0.5 font-medium hover:bg-red-500/20"
          >
            Reload theirs
          </button>
        </div>
      )}

      <div className="mx-2 h-5 w-px bg-hairline" />

      <div className="flex items-center gap-1">
        <IconBtn title="Undo (⌘Z)" onClick={undo}><Undo2 className="h-4 w-4" /></IconBtn>
        <IconBtn title="Redo (⌘⇧Z)" onClick={redo}><Redo2 className="h-4 w-4" /></IconBtn>
      </div>

      <div className="ml-auto flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex h-8 items-center gap-2 rounded-md border hairline bg-panel-2 px-2.5 text-sm hover:bg-panel-3">
              <A.Icon className="h-4 w-4 text-muted-foreground" />
              <span className="tabular">{aspect}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="label-caps">Aspect ratio</DropdownMenuLabel>
            {(Object.keys(ASPECTS) as AspectKey[]).map((k) => {
              const Item = ASPECTS[k];
              return (
                <DropdownMenuItem key={k} onClick={() => setAspect(k)} className="flex items-center gap-2">
                  <Item.Icon className="h-4 w-4 text-muted-foreground" />
                  <span>{Item.label}</span>
                  {aspect === k && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-brand" />}
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="tabular rounded-md border hairline bg-panel-2 px-2 py-1 text-[11px] text-muted-foreground">
          {doc.canvas.width}×{doc.canvas.height} · {doc.canvas.fps}fps
        </span>

        <IconBtn
          title={`Switch to ${theme === "light" ? "dark" : "light"} theme`}
          onClick={onToggleTheme}
        >
          {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </IconBtn>

        <Button variant="ghost" size="sm" className="h-8" onClick={onRenders}>
          <Layers className="mr-1.5 h-4 w-4" /> Renders
        </Button>
        <Button size="sm" className="h-8 bg-brand text-brand-foreground hover:bg-brand/90" onClick={onExport}>
          Export
        </Button>
      </div>
    </header>
  );
}

function IconBtn({ children, title, active, onClick }: { children: React.ReactNode; title?: string; active?: boolean; onClick?: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground",
        active && "bg-panel-2 text-foreground"
      )}
    >
      {children}
    </button>
  );
}

// ───────────────────────────── Left rail ──────────────────────────────────

function LeftRail({ projectId, doc, onSelect }: { projectId: string; doc: EditDoc; onSelect: (s: Selection) => void }) {
  return (
    <aside className="flex min-h-0 flex-col border-r hairline bg-panel">
      <Tabs defaultValue="media" className="flex min-h-0 flex-1 flex-col">
        <div className="px-3 pt-3">
          <TabsList className="grid h-9 w-full grid-cols-3 bg-panel-2">
            <TabsTrigger value="media" className="text-xs">Media</TabsTrigger>
            <TabsTrigger value="captions" className="text-xs">Captions</TabsTrigger>
            <TabsTrigger value="plugins" className="text-xs">Plugins</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="media" className="mt-0 flex min-h-0 flex-1 flex-col">
          <MediaPanel projectId={projectId} doc={doc} />
        </TabsContent>

        <TabsContent value="captions" className="mt-0 flex min-h-0 flex-1 flex-col">
          <CaptionsPanel projectId={projectId} doc={doc} onSelect={onSelect} />
        </TabsContent>

        <TabsContent value="plugins" className="mt-0 flex min-h-0 flex-1 flex-col">
          <PluginsPanel projectId={projectId} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

// transcribeToCues runs Whisper on an asset and merges the resulting cues into
// the caption track, anchored to where the asset's clip sits on the timeline
// (shifted by start−in, clipped to the trimmed window). Returns the cue count.
async function transcribeToCues(projectId: string, asset: Asset): Promise<number> {
  const { jobId } = await api.transcribe(projectId, asset.id);
  const data = await awaitJob(jobId);
  const raw = (data?.cues as CaptionCue[] | undefined) ?? null;
  if (!raw) throw new Error("result was lost (connection blip) — try again");
  const st = useStudio.getState();
  const doc = st.doc;
  if (!doc) return 0;
  let offset = 0;
  let lo = -Infinity;
  let hi = Infinity;
  outer: for (const t of doc.tracks)
    for (const c of t.clips ?? [])
      if (c.assetId === asset.id && !c.sourceClip) {
        offset = c.start - c.in;
        lo = c.in;
        hi = c.out;
        break outer;
      }
  const cues = raw
    .filter((q) => q.end > lo && q.start < hi)
    .map((q) => ({
      ...q,
      start: +(Math.max(q.start, lo) + offset).toFixed(3),
      end: +(Math.min(q.end, hi) + offset).toFixed(3),
    }));
  if (cues.length) {
    const existing = captionTrack(doc)?.cues ?? [];
    st.setCues([...existing, ...cues].sort((a, b) => a.start - b.start));
  }
  return cues.length;
}

// Whisper availability, probed once and cached. Auto-transcribe stays silent
// when it's unavailable so a machine without whisper.cpp doesn't get a failure
// toast on every import; the manual Captions button still reports the reason.
let whisperReady: boolean | null = null;
async function transcribeAvailable(): Promise<boolean> {
  if (whisperReady === null) {
    try {
      whisperReady = (await api.capabilities()).transcribe;
    } catch {
      whisperReady = false;
    }
  }
  return whisperReady;
}

// autoTranscribe fires after an import lands a video with audio: best-effort in
// the background, reports via toasts, never throws. No-ops when whisper is
// unavailable so imports don't spam errors on machines without it.
async function autoTranscribe(projectId: string, asset: Asset) {
  if (asset.kind !== "video" || asset.hasAudio === false) return;
  if (!(await transcribeAvailable())) return;
  try {
    toast.info(`Transcribing ${asset.name}…`);
    const n = await transcribeToCues(projectId, asset);
    if (n) toast.success(`${asset.name}: ${n} captions added`);
    else toast.info(`${asset.name}: no speech found`);
  } catch (e) {
    toast.error(`Transcribe failed: ${(e as Error).message}`);
  }
}

function CaptionsPanel({ projectId, doc, onSelect }: { projectId: string; doc: EditDoc; onSelect: (s: Selection) => void }) {
  const addCue = useStudio((s) => s.addCue);
  const updateCue = useStudio((s) => s.updateCue);
  const removeCue = useStudio((s) => s.removeCue);
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [whisper, setWhisper] = useState<{ transcribe: boolean; transcribeError: string } | null>(null);

  useEffect(() => {
    api.capabilities().then(setWhisper).catch(() => {});
  }, []);

  const cues = captionTrack(doc)?.cues ?? [];
  const audible = doc.assets.filter((a) => a.kind !== "image");

  const transcribe = async () => {
    const id = assetId || audible[0]?.id;
    const asset = doc.assets.find((a) => a.id === id);
    if (!asset) return;
    setBusy(true);
    try {
      const n = await transcribeToCues(projectId, asset);
      toast.success(`Added ${n} caption cues`);
    } catch (e) {
      toast.error("Transcription failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="text-sm font-medium">Captions</div>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => addCue()}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Cue
        </Button>
      </div>
      <div className="px-3 pb-2">
        <div className="flex items-center gap-1.5">
          <Select value={assetId || audible[0]?.id || ""} onValueChange={setAssetId}>
            <SelectTrigger className="h-8 flex-1 bg-panel-2 text-[12px]"><SelectValue placeholder="pick audio/video" /></SelectTrigger>
            <SelectContent>
              {audible.map((a) => (
                <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" className="h-8 bg-brand text-xs text-brand-foreground hover:bg-brand/90 disabled:opacity-40" disabled={busy || audible.length === 0 || whisper?.transcribe === false} onClick={transcribe}>
            {busy ? "…" : "Transcribe"}
          </Button>
        </div>
        {whisper?.transcribe === false ? (
          <div className="mt-1 text-[10.5px] text-amber-400/90">Transcription unavailable — install whisper.cpp + a model. See README.</div>
        ) : (
          <div className="mt-1 text-[10.5px] text-muted-foreground">Speech → timed caption cues (Whisper). Videos with audio auto-transcribe on import.</div>
        )}
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-3">
        {cues.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">No captions yet. Transcribe a clip or add a cue.</div>
        ) : (
          <div className="space-y-1">
            {cues.map((c) => (
              <div key={c.id} className="rounded-md border hairline bg-panel-2/60 p-1.5">
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <span className="tabular">{c.start.toFixed(1)}–{c.end.toFixed(1)}s</span>
                  <div className="flex-1" />
                  <button className="text-brand hover:underline" onClick={() => onSelect({ kind: "cue", cueId: c.id })}>edit</button>
                  <button className="text-destructive hover:underline" onClick={() => removeCue(c.id)}>✕</button>
                </div>
                <input
                  value={c.text}
                  onChange={(e) => updateCue(c.id, { text: e.target.value })}
                  className="mt-1 h-7 w-full rounded border hairline bg-panel px-1.5 text-[12px] outline-none focus:border-brand/50"
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function MediaPanel({ projectId, doc }: { projectId: string; doc: EditDoc }) {
  const addAsset = useStudio((s) => s.addAsset);
  const addClipToLane = useStudio((s) => s.addClipToLane);
  const removeAsset = useStudio((s) => s.removeAsset);
  const [busy, setBusy] = useState(false);
  const [lib, setLib] = useState(false);
  const [recording, setRecording] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const { asset } = await api.importAsset(projectId, f);
        addAsset(asset);
        void autoTranscribe(projectId, asset);
      }
    } catch (e) {
      toast.error(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const addToTimeline = (a: Asset) => {
    addClipToLane(a.id);
  };

  return (
    <>
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <div className="text-sm font-medium">{recording ? "Record" : "Media"}</div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            title="Record your screen, camera or microphone"
            className={cn("h-7 px-2 text-xs", recording && "bg-panel-2 text-foreground")}
            onClick={() => setRecording((v) => !v)}
          >
            <Circle className={cn("mr-1 h-3 w-3", recording ? "fill-red-500 text-red-500" : "text-red-500")} />
            {recording ? "Close" : "Record"}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setLib(true)}>
            <Library className="mr-1 h-3.5 w-3.5" /> Library
          </Button>
          <Button
            size="sm"
            className="h-7 bg-panel-3 px-2 text-xs text-foreground hover:bg-panel-3/80"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <ImportIcon className="mr-1 h-3.5 w-3.5" /> {busy ? "…" : "Import"}
          </Button>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            className="hidden"
            onChange={(e) => {
              onFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
      {recording ? (
        <RecordPanel projectId={projectId} onClose={() => setRecording(false)} />
      ) : (
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-3">
        {doc.assets.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
            Record your screen, import media, browse your Library, or generate a clip from the Plugins tab.
          </div>
        ) : (
          <div className="space-y-1.5">
            {doc.assets.map((a) => (
              <MediaCard key={a.id} asset={a} onAdd={() => addToTimeline(a)} onRemove={() => removeAsset(a.id)} />
            ))}
          </div>
        )}
      </div>
      )}

      {lib && (
        <div className="legacy">
          <LibraryModal
            projectId={projectId}
            onClose={() => setLib(false)}
            onImported={(a) => {
              addAsset(a);
              void autoTranscribe(projectId, a);
            }}
          />
        </div>
      )}
    </>
  );
}

// Where each captured source belongs on the timeline. Screen is the spine;
// a webcam is picture-in-picture over it; narration is its own audio lane so
// its level stays independent of whatever the screen recording picked up.
const RECORD_LANE: Record<RecordKind, "video" | "overlay" | "audio"> = {
  screen: "video",
  camera: "overlay",
  mic: "audio",
};

function RecordPanel({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const addAsset = useStudio((s) => s.addAsset);
  const addSyncedClips = useStudio((s) => s.addSyncedClips);
  const [opts, setOpts] = useState<RecordOptions>({
    screen: true,
    camera: false,
    mic: true,
    systemAudio: false,
    fps: 30,
  });
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [handle, setHandle] = useState<RecordingHandle | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cursord, setCursord] = useState<CursorHealth | null>(null);
  const [trackCursor, setTrackCursor] = useState(true);
  const [ownCursor, setOwnCursor] = useState(true);
  const screenRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const supported = isRecordingSupported();

  useEffect(() => {
    void listInputs().then(({ mics }) => setMics(mics));
  }, [handle]);

  // The cursor helper is optional and usually absent, so this is a quiet probe
  // whose only effect is whether we offer the checkbox.
  useEffect(() => {
    void probeCursord().then(setCursord);
  }, []);

  // Elapsed clock. Derived from the handle's start rather than counted up, so
  // it stays honest if the tab is backgrounded and timers are throttled.
  useEffect(() => {
    if (!handle || paused) return;
    const t = setInterval(() => setElapsed((Date.now() - handle.startedAt) / 1000), 200);
    return () => clearInterval(t);
  }, [handle, paused]);

  // Attach the live streams to their preview elements so you can see what is
  // actually being captured before committing minutes to it.
  useEffect(() => {
    if (screenRef.current && handle?.preview.screen) screenRef.current.srcObject = handle.preview.screen;
    if (cameraRef.current && handle?.preview.camera) cameraRef.current.srcObject = handle.preview.camera;
  }, [handle]);

  const set = (patch: Partial<RecordOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const finish = useCallback(
    async (h: RecordingHandle) => {
      setSaving(true);
      try {
        const tracks = await h.stop();
        // Always collect what the helper has, even if we end up not attaching
        // it — leaving it running would poison the next recording's session.
        const cursorRec = h.cursorTracking ? await stopCursorTracking() : null;
        setHandle(null);
        setPaused(false);
        if (!tracks.length) {
          toast.error("Nothing was captured.");
          return;
        }
        const placed: { assetId: string; lane: "video" | "overlay" | "audio"; startedAt: number }[] = [];
        for (const tr of tracks) {
          // Cursor data belongs only to the screen capture, and only when that
          // capture is a whole monitor — see canMapToVideo.
          const mappable = tr.kind === "screen" && tr.video && canMapToVideo(tr.surface);
          const sidecar = cursorRec && mappable
            ? toSidecar(cursorRec, tr.startedAt, tr.video!, !!tr.cursorHidden)
            : undefined;
          const res = await api.ingestRecording(
            projectId,
            tr.blob,
            tr.filename,
            `recording-${tr.kind}`,
            sidecar
          );
          if (!res.asset) {
            toast.error(`${tr.kind}: ${res.importError || "upload failed"}`);
            continue;
          }
          if (res.remuxError) toast.error(`${tr.kind}: couldn't repair the container — scrubbing may be rough.`);
          if (res.cursorError) toast.error(`${tr.kind}: cursor data rejected — ${res.cursorError}`);
          addAsset(res.asset);
          placed.push({ assetId: res.asset.id, lane: RECORD_LANE[tr.kind], startedAt: tr.startedAt });
        }
        // Say why, rather than leaving the effects mysteriously unavailable.
        if (cursorRec && !tracks.some((tr) => tr.kind === "screen" && canMapToVideo(tr.surface))) {
          toast.info("Cursor data needs a whole-screen recording — a window or tab share can't be mapped.");
        }
        if (placed.length) {
          addSyncedClips(placed);
          toast.success(`${placed.length} recorded track${placed.length > 1 ? "s" : ""} → timeline`);
        }
      } catch (e) {
        toast.error(String((e as Error)?.message || e));
      } finally {
        setSaving(false);
      }
    },
    [projectId, addAsset, addSyncedClips]
  );

  const start = async () => {
    try {
      // Start tracking before capture, so the pointer's position is already
      // known at frame zero rather than only from its first movement after.
      const wantCursor = !!cursord?.supported && trackCursor && opts.screen;
      const tracking = wantCursor ? await startCursorTracking() : false;
      // Only hide the real cursor once tracking is confirmed running, or the
      // recording would have no cursor at all rather than an editable one.
      opts.hideCursor = tracking && ownCursor;
      if (wantCursor && !tracking) toast.info("Cursor helper didn't start — recording without it.");

      const h = await startRecording(opts);
      h.cursorTracking = tracking;
      setElapsed(0);
      setHandle(h);
      // The browser's own "Stop sharing" bar ends the stream without going
      // through our button, so the recording has to finish itself.
      h.preview.screen?.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => void finish(h))
      );
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // Cancelling the picker is a normal thing to do, not an error worth shouting about.
      if (/permission|denied|abort/i.test(msg)) toast.info("Recording cancelled.");
      else toast.error(msg);
    }
  };

  if (!supported) {
    return (
      <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
        This browser can't capture the screen. Chrome, Edge or Firefox on desktop can.
        <div className="mt-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Back to media</Button>
        </div>
      </div>
    );
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(Math.floor(elapsed % 60)).padStart(2, "0");

  return (
    <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-2">
      {handle ? (
        <>
          <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2">
            <span className={cn("h-2 w-2 rounded-full bg-red-500", !paused && "animate-pulse")} />
            <span className="text-[12px] font-medium tabular">{mm}:{ss}</span>
            <span className="text-[10px] text-muted-foreground">{paused ? "paused" : "recording"}</span>
          </div>
          {handle.preview.screen && (
            <video ref={screenRef} autoPlay muted playsInline className="w-full rounded border hairline bg-black" />
          )}
          {handle.preview.camera && (
            <video ref={cameraRef} autoPlay muted playsInline className="w-full rounded border hairline bg-black" />
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 flex-1 bg-panel-3 text-xs"
              onClick={() => {
                paused ? handle.resume() : handle.pause();
                setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              disabled={saving}
              className="h-7 flex-1 bg-red-600 text-xs text-white hover:bg-red-600/90"
              onClick={() => void finish(handle)}
            >
              {saving ? "Saving…" : "Stop"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="space-y-1">
            <ToggleRow label="Screen" hint="You'll pick the display or window next." checked={opts.screen} onChange={(v) => set({ screen: v })} />
            <ToggleRow label="Camera" hint="Lands on the overlay track as picture-in-picture." checked={opts.camera} onChange={(v) => set({ camera: v })} />
            <ToggleRow label="Microphone" hint="Its own audio track, so narration stays adjustable." checked={opts.mic} onChange={(v) => set({ mic: v })} />
            <ToggleRow
              label="System audio"
              hint={opts.screen ? "Chrome only, and only for a tab or window share." : "Needs a screen share."}
              checked={opts.systemAudio && opts.screen}
              disabled={!opts.screen}
              onChange={(v) => set({ systemAudio: v })}
            />
            {cursord?.supported && (
              <ToggleRow
                label="Studio draws the cursor"
                hint={
                  !trackCursor || !opts.screen
                    ? "Needs cursor tracking."
                    : "Keeps the real cursor out of the recording so it can be smoothed, resized and restyled afterwards."
                }
                checked={ownCursor && trackCursor && opts.screen}
                disabled={!trackCursor || !opts.screen}
                onChange={setOwnCursor}
              />
            )}
            {cursord?.supported ? (
              <ToggleRow
                label="Cursor tracking"
                hint={
                  !opts.screen
                    ? "Needs a screen share."
                    : cursord.clicks
                      ? "Records pointer motion and clicks for cursor effects. Share a whole screen."
                      : "Records pointer motion. Clicks aren't visible on this platform."
                }
                checked={trackCursor && opts.screen}
                disabled={!opts.screen}
                onChange={setTrackCursor}
              />
            ) : (
              <div className="px-1 py-1 text-[10px] leading-snug text-muted-foreground">
                Cursor effects need the local <code className="font-mono">cursord</code> helper.
                Run it from <code className="font-mono">tools/cursord</code> and reopen this panel.
              </div>
            )}
          </div>
          {opts.mic && mics.length > 1 && (
            <select
              value={opts.micDeviceId ?? ""}
              onChange={(e) => set({ micDeviceId: e.target.value || undefined })}
              className="h-7 w-full rounded border hairline bg-panel px-1 text-[11px] outline-none"
            >
              <option value="">Default microphone</option>
              {mics.map((m, i) => (
                <option key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>
              ))}
            </select>
          )}
          <Field label="Frame rate">
            <select
              value={opts.fps}
              onChange={(e) => set({ fps: Number(e.target.value) })}
              className="h-7 w-full rounded border hairline bg-panel px-1 text-[11px] outline-none"
            >
              <option value={24}>24 fps</option>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps — smoother, larger files</option>
            </select>
          </Field>
          <Button
            size="sm"
            className="h-8 w-full bg-red-600 text-xs text-white hover:bg-red-600/90 disabled:opacity-40"
            disabled={!opts.screen && !opts.camera && !opts.mic}
            onClick={() => void start()}
          >
            ● Start recording
          </Button>
          <div className="text-[10px] leading-relaxed text-muted-foreground">
            Each source becomes its own clip, aligned to the moment they started — so
            narration and screen stay in sync but can be edited apart.
          </div>
        </>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 rounded px-1 py-1", disabled && "cursor-default opacity-45")}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 accent-brand"
      />
      <span className="min-w-0">
        <span className="block text-[11.5px] leading-tight">{label}</span>
        {hint && <span className="block text-[10px] leading-snug text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

function MediaCard({ asset, onAdd, onRemove }: { asset: Asset; onAdd: () => void; onRemove: () => void }) {
  const Icon = asset.kind === "video" ? VideoIcon : asset.kind === "audio" ? Music2 : ImageIcon;
  return (
    <div
      onClick={onAdd}
      title="Click to add at playhead · or drag onto a track"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/assetId", asset.id);
        // Kind-scoped type so a track row can validate compatibility during
        // dragover (getData is blocked until drop; types is readable).
        e.dataTransfer.setData(`asset/${asset.kind}`, asset.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      className="group relative flex cursor-grab items-center gap-2.5 rounded-lg border border-transparent bg-panel-2/60 p-2 transition-colors hover:border-hairline hover:bg-panel-2 active:cursor-grabbing"
    >
      <div className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-gradient-to-br from-panel-3 to-panel">
        {asset.thumbnail ? (
          <img src={mediaUrl(asset.thumbnail, asset.createdAt)} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <div
            className="absolute inset-0 opacity-60"
            style={{ background: `linear-gradient(135deg, hsl(${hueFor(asset.id)} 60% 25%), hsl(${(hueFor(asset.id) + 40) % 360} 70% 15%))` }}
          />
        )}
        <Icon className="relative h-4 w-4 text-white/80" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <div className="truncate text-[13px] font-medium">{asset.name}</div>
          <span className="rounded bg-panel-3 px-1 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
            {asset.source}
          </span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground tabular">
          {asset.kind} · {asset.duration.toFixed(1)}s{asset.hasAlpha ? " · alpha" : ""}
          {asset.kind === "video" && asset.hasAudio === false ? " · silent" : ""}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (confirm(`Remove "${asset.name}" and any clips using it?`)) onRemove();
        }}
        title="Remove asset (and its clips)"
        className="absolute right-1.5 top-1.5 hidden h-5 w-5 items-center justify-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground group-hover:flex"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}

const PLUGIN_SOURCES: Record<string, string[]> = {
  newaniadv: ["newaniadv", "newaniadv-root"],
  hyperframes: ["hyperframes", "hyper-app"],
  funkycode: ["funkycode"],
};

function PluginsPanel({ projectId }: { projectId: string }) {
  const addAsset = useStudio((s) => s.addAsset);
  const addClipToLane = useStudio((s) => s.addClipToLane);
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  const [apps, setApps] = useState<Record<string, AppStatus>>({});
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [studioFor, setStudioFor] = useState<AppStatus | null>(null);
  const [genFor, setGenFor] = useState<string | null>(null);
  const [pluginState, setPluginState] = useState<PluginState | null>(null);
  const [reloading, setReloading] = useState(false);

  const loadPlugins = useCallback(() => {
    api.generators().then(setGens).catch(() => {});
    api.plugins().then(setPluginState).catch(() => setPluginState(null));
  }, []);
  useEffect(loadPlugins, [loadPlugins]);

  // Plugins are loaded from a directory at runtime, so a manifest can be added or
  // fixed without restarting — this picks the change up without a page reload.
  const reload = async () => {
    setReloading(true);
    try {
      const { generators, errors } = await api.reloadPlugins();
      loadPlugins();
      if (errors.length) toast.error(`${errors.length} plugin(s) failed to load.`);
      else toast.success(`${generators} plugin(s) loaded.`);
    } catch (e) {
      toast.error(`Reload failed: ${(e as Error).message}`);
    } finally {
      setReloading(false);
    }
  };
  // Poll live dev-server status for the plugin cards' live/booting dots.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .apps()
        .then((l) => {
          if (!alive) return;
          setApps(Object.fromEntries(l.map((a) => [a.id, a])));
          setAppsLoaded(true);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const importEntry = async (e: LibraryEntry, toTimeline: boolean) => {
    const { asset } = await api.importFromLibrary(projectId, e.path, e.name);
    addAsset(asset);
    if (toTimeline) addClipToLane(asset.id);
    toast.success(`Imported ${e.name}${toTimeline ? " → timeline" : ""}`);
    void autoTranscribe(projectId, asset);
    return asset as Asset;
  };

  // A finished generate job's SSE payload carries the freshly registered asset;
  // if the terminal event was missed (poll fallback resolves null), re-fetch the
  // project and merge any assets the backend added that we don't have yet.
  const onGenerated = async (asset: Asset | null) => {
    if (!asset) {
      try {
        const fresh = await api.getProject(projectId);
        const have = new Set(useStudio.getState().doc?.assets.map((a) => a.id));
        asset = fresh.assets.find((a) => !have.has(a.id)) ?? null;
      } catch {
        /* leave asset null */
      }
    }
    if (!asset) {
      toast.error("Generated, but the clip didn't come back — check the Media tab.");
      return;
    }
    addAsset(asset);
    addClipToLane(asset.id);
    toast.success(`${asset.name} → timeline`);
    void autoTranscribe(projectId, asset);
  };

  const openStudio = async (g: GeneratorStatus) => {
    const app = apps[g.id];
    if (!app) {
      toast.error("This app isn't configured as a runnable dev server.");
      return;
    }
    if (app.state !== "running") {
      try {
        await api.startApp(g.id);
        toast.info(`Starting ${g.name}… Studio runs it in the background.`);
      } catch (e) {
        toast.error(`Couldn't start ${g.name}: ${(e as Error).message}`);
        return;
      }
    }
    setStudioFor({ ...app, id: g.id });
  };

  return (
    <>
      <div className="flex items-start justify-between gap-2 px-3 pt-3 pb-2">
        <div className="text-[11px] leading-relaxed text-muted-foreground">
          Generate a clip here and it stays editable — click it on the timeline to change
          its properties and re-render.
        </div>
        <button
          onClick={reload}
          disabled={reloading}
          title={pluginState?.dir ? `Re-scan ${pluginState.dir}` : "Re-scan the plugin directory"}
          className="shrink-0 rounded border hairline px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-panel-2 disabled:opacity-40"
        >
          {reloading ? "…" : "Reload"}
        </button>
      </div>
      <div className="scrollbar-thin flex-1 overflow-y-auto px-2 pb-3">
        {gens.length === 0 ? (
          <div className="px-2 py-6 text-center text-[11px] text-muted-foreground">No plugins configured.</div>
        ) : (
          <div className="space-y-1.5">
            {/* A plugin whose manifest failed to load is simply absent from the
                list, which is impossible to debug. Say so instead. */}
            {!!pluginState?.errors.length && (
              <div className="space-y-1 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-[11px]">
                <div className="font-medium text-red-300">
                  {pluginState.errors.length} plugin(s) failed to load
                </div>
                {pluginState.errors.map((e) => (
                  <div key={e.path} className="text-[10px] text-red-200/80">
                    <span className="font-mono">{e.path.split("/").slice(-2).join("/")}</span> — {e.error}
                  </div>
                ))}
              </div>
            )}
            {gens.map((g) => {
              const app = apps[g.id];
              const live = app?.state === "running" && app?.healthy;
              const booting = app?.state === "running" && !app?.healthy;
              // Generate-only plugins (e.g. Voiceover) have no runnable dev
              // server, so once the app list has loaded and this id isn't in it,
              // drop the dead "Start & open" button and let Generate fill the row.
              const isApp = !appsLoaded || !!app;
              return (
                <div key={g.id} className="rounded-lg border hairline bg-panel-2/60 p-2">
                  <div className="flex items-center gap-2.5">
                    <div
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold text-white"
                      style={{ background: `linear-gradient(135deg, hsl(${hueFor(g.id)} 70% 55%), hsl(${(hueFor(g.id) + 60) % 360} 70% 45%))` }}
                    >
                      {g.name[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <div className="truncate text-[13px] font-medium">{g.name}</div>
                        {live && <span className="rounded-full bg-signal-soft px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-signal">live</span>}
                        {booting && <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-amber-400">booting…</span>}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">{g.description}</div>
                    </div>
                  </div>
                  <div className="mt-2 flex gap-1.5">
                    {isApp && (
                      <Button
                        size="sm"
                        className="h-7 flex-1 bg-brand text-xs text-brand-foreground hover:bg-brand/90 disabled:opacity-40"
                        disabled={!app}
                        onClick={() => openStudio(g)}
                      >
                        <ImportIcon className="mr-1 h-3.5 w-3.5" /> {live ? "Open in Studio" : "Start & open"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      title={g.available ? `Generate a clip with ${g.name} without leaving Studio` : g.buildHint || "Generator CLI not available"}
                      className="h-7 flex-1 bg-panel-3 text-xs text-foreground hover:bg-panel-3/80 disabled:opacity-40"
                      disabled={!g.available}
                      onClick={() => setGenFor(genFor === g.id ? null : g.id)}
                    >
                      <Wand2 className="mr-1 h-3.5 w-3.5" /> Generate
                    </Button>
                  </div>
                  {genFor === g.id && (
                    <GenerateForm projectId={projectId} gen={g} onDone={onGenerated} />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {studioFor && (
        <div className="legacy">
          <AppStudio
            app={studioFor}
            sources={PLUGIN_SOURCES[studioFor.id] || []}
            onClose={() => setStudioFor(null)}
            onImport={importEntry}
          />
        </div>
      )}
    </>
  );
}

// GenerateForm is the inline "create a clip without leaving Studio" path: it
// feeds the generator CLI (which does the real render — narration included)
// and the finished file lands in the project automatically.
function GenerateForm({
  projectId,
  gen,
  onDone,
}: {
  projectId: string;
  gen: GeneratorStatus;
  onDone: (asset: Asset | null) => Promise<void> | void;
}) {
  const hasSchema = !!gen.fields?.length;
  // With a schema, authoring starts from the schema's own defaults so a new clip
  // is renderable immediately; the canned sample is only for raw-document
  // generators, which have nothing else to go on.
  const [doc, setDoc] = useState<Doc>(() => seedDoc(parseDoc(undefined, gen.docRoot), gen.fields ?? []));
  const [input, setInput] = useState(() => SAMPLES[gen.inputKind] ?? "");
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const setParam = (flag: string, v: string) => setParams((p) => ({ ...p, [flag]: v }));

  const run = async () => {
    const payload = hasSchema ? serializeDoc(doc) : input;
    if (!payload.trim()) {
      toast.error("Input is empty.");
      return;
    }
    setBusy(true);
    try {
      const { jobId } = await api.generate(projectId, gen.id, payload, params);
      const data = await awaitJob(jobId);
      await onDone((data?.asset as Asset) ?? null);
    } catch (e) {
      toast.error(`Generate failed: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2 rounded-md border hairline bg-panel/60 p-2">
      {hasSchema ? (
        <PluginDocEditor fields={gen.fields!} doc={doc} onChange={setDoc} />
      ) : (
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          spellCheck={false}
          className="scrollbar-thin h-36 resize-y bg-panel-2 font-mono text-[11px] leading-snug"
        />
      )}
      {gen.params.length > 0 && (
        <div className="space-y-1.5">
          {gen.params.map((spec) => (
            <ParamControl key={spec.flag} spec={spec} value={params[spec.flag] ?? spec.default ?? ""} onChange={(v) => setParam(spec.flag, v)} />
          ))}
        </div>
      )}
      <Button
        size="sm"
        className="h-7 w-full bg-brand text-xs text-brand-foreground hover:bg-brand/90 disabled:opacity-40"
        disabled={busy}
        onClick={run}
      >
        <Wand2 className="mr-1 h-3.5 w-3.5" /> {busy ? "Generating… (see Jobs)" : "Generate → timeline"}
      </Button>
    </div>
  );
}

function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: string; onChange: (v: string) => void }) {
  if (spec.type === "bool") {
    return (
      <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <input
          type="checkbox"
          checked={value === "true" || value === "1"}
          onChange={(e) => onChange(e.target.checked ? "true" : "")}
          className="h-3.5 w-3.5 accent-[var(--brand)]"
        />
        {spec.label}
      </label>
    );
  }
  if (spec.type === "enum") {
    return (
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{spec.label}</span>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-6 rounded border hairline bg-panel-2 px-1 text-[11px] text-foreground"
        >
          {(spec.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-[11px] text-muted-foreground">{spec.label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-6 w-24 rounded border hairline bg-panel-2 px-1.5 text-right text-[11px] text-foreground"
      />
    </div>
  );
}

// ─────────────────────────── Center column ────────────────────────────────

function CenterColumn({
  doc,
  aspect,
  selection,
  expanded,
  onToggleExpand,
  onSelect,
  total,
}: {
  doc: EditDoc;
  aspect: AspectKey;
  selection: Selection;
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onSelect: (s: Selection) => void;
  total: number;
}) {
  // Bottom editor view: the new Premiere-style Timeline (default) or the legacy
  // card Spine. Persisted so a session keeps whichever the user prefers.
  const [view, setView] = useState<"timeline" | "spine">(
    () => (localStorage.getItem("studio-editor-view") as "timeline" | "spine") || "timeline"
  );
  const pick = (v: "timeline" | "spine") => {
    setView(v);
    localStorage.setItem("studio-editor-view", v);
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <PreviewStage doc={doc} aspect={aspect} selection={selection} total={total} />

      <div className="flex shrink-0 items-center gap-1 border-t hairline bg-panel/60 px-3 pt-1.5">
        <button
          onClick={() => pick("timeline")}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            view === "timeline" ? "bg-panel-3 text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Timeline
        </button>
        <button
          onClick={() => pick("spine")}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            view === "spine" ? "bg-panel-3 text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Spine
        </button>
      </div>

      {view === "timeline" ? (
        <Timeline doc={doc} selection={selection} onSelect={onSelect} total={total} />
      ) : (
        <SpineArea
          doc={doc}
          selection={selection}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
          total={total}
        />
      )}
    </section>
  );
}

function PreviewStage({ doc, aspect, selection, total }: { doc: EditDoc; aspect: AspectKey; selection: Selection; total: number }) {
  const playing = useStudio((s) => s.playing);
  const playhead = useStudio((s) => s.playhead);
  const setPlaying = useStudio((s) => s.setPlaying);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const addCue = useStudio((s) => s.addCue);
  const updateClip = useStudio((s) => s.updateClip);
  const beginTransient = useStudio((s) => s.beginTransient);
  const commitTransient = useStudio((s) => s.commitTransient);

  const W = doc.canvas.width;
  const H = doc.canvas.height;
  const ratio = W / H;
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const [stage, setStage] = useState({ w: 320, h: 180 });

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const fit = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio]);

  const soloActive = doc.tracks.some((t) => t.solo);
  const visuals = activeVisuals(doc.tracks, playhead);
  const audios = activeAudios(doc.tracks, playhead, soloActive);
  const visualsKey = visuals.map((x) => x.clip.id).join(",");
  const audiosKey = audios.map((x) => x.clip.id).join(",");

  // Prefetch waveform peaks for the audible clips so the level meter reads real
  // levels (peaksNow is a synchronous cache read); re-render once they resolve.
  const [, bumpPeaks] = useState(0);
  useEffect(() => {
    let alive = true;
    Promise.all(audios.map((a) => getPeaks(doc.id, a.clip.assetId))).then(() => alive && bumpPeaks((n) => n + 1));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, audiosKey]);

  // sync video elements to the playhead
  useEffect(() => {
    for (const { track, clip } of visuals) {
      const v = videoRefs.current[clip.id];
      if (!v) continue;
      v.muted = !!track.muted || (soloActive && !track.solo) || !!clip.mute;
      // volume 0 means "unset" in the schema (omitempty); the export renders it
      // at full gain, so the preview must agree.
      v.volume = Math.max(0, Math.min(1, clip.volume || 1));
      const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
      if (v.playbackRate !== sp) v.playbackRate = sp;
      // Hold region: the source has played out but the clip continues as a frozen
      // last frame. Pin to the final frame and pause — never advance into black.
      if (playhead >= clip.start + clipSrcDur(clip) - 1e-3) {
        const last = Math.max(clip.in, clip.out - 0.04);
        if (Math.abs(v.currentTime - last) > 0.05) {
          try {
            v.currentTime = last;
          } catch {}
        }
        if (!v.paused) v.pause();
        continue;
      }
      const local = clip.in + (playhead - clip.start) * sp;
      if (Math.abs(v.currentTime - local) > 0.25) {
        try {
          v.currentTime = local;
        } catch {}
      }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing, soloActive, visualsKey]);

  // sync audio-track elements (music) to the playhead
  useEffect(() => {
    for (const { clip } of audios) {
      const a = audioRefs.current[clip.id];
      if (!a) continue;
      a.volume = Math.max(0, Math.min(1, clip.volume || 1));
      const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
      if (a.playbackRate !== sp) a.playbackRate = sp;
      const local = clip.in + (playhead - clip.start) * sp;
      if (Math.abs(a.currentTime - local) > 0.25) {
        try {
          a.currentTime = local;
        } catch {}
      }
      if (playing && a.paused) a.play().catch(() => {});
      if (!playing && !a.paused) a.pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing, audiosKey]);

  // Cursor tracks resolve asynchronously; a repaint once they land is what
  // gets the effects on screen without polling.
  const [, bumpCursor] = useState(0);
  useEffect(() => {
    let alive = true;
    const withFX = visuals.filter(({ clip }) => clip.cursor);
    if (!withFX.length) return;
    Promise.all(withFX.map(({ clip }) => getCursorTrack(doc.id, clip.assetId))).then(
      () => alive && bumpCursor((n) => n + 1)
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.id, visualsKey]);

  // draw cursor effects, then the active caption cue, onto the overlay canvas
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    cv.width = stage.w;
    cv.height = stage.h;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);

    // Cursor emphasis sits under captions, which are the topmost layer, and is
    // placed through each clip's own box so it rides any zoom — the same rule
    // the export follows.
    for (const { clip } of visuals) {
      if (!clip.cursor) continue;
      const track = cursorTrackNow(doc.id, clip.assetId);
      if (!track) continue;
      const box = clipBox(clip, playhead, stage.w, stage.h, W, H);
      drawCursorFX(ctx, clip, track, box, playhead - clip.start, stage.w / W);
    }

    const cue = captionTrack(doc)?.cues?.find((c) => playhead >= c.start && playhead < c.end);
    if (cue) {
      const size = (cue.style.size / H) * stage.h;
      ctx.font = `600 ${size}px Inter, sans-serif`;
      ctx.textAlign = cue.style.align === "left" ? "left" : cue.style.align === "right" ? "right" : "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = cue.style.color || "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = size / 8;
      const x = cue.style.align === "left" ? stage.w * 0.08 : cue.style.align === "right" ? stage.w * 0.92 : stage.w / 2;
      const y = cue.style.posY * stage.h;
      ctx.strokeText(cue.text, x, y);
      ctx.fillText(cue.text, x, y);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, stage, doc, H, W, visualsKey]);

  const bg = doc.tracks.find((t) => t.kind === "background")?.backgroundColor || "#000";
  const level = audioLevel(doc.id, doc.assets, audios, playhead);

  // selected clip for on-canvas manipulation
  const selClip = "clipId" in selection ? findClip(doc, selection.trackId, selection.clipId) : undefined;
  const selTrackId = "trackId" in selection ? selection.trackId : "";
  const selActive = !!selClip && playhead >= selClip.start && playhead < clipEnd(selClip);
  const selBox = selClip && selActive ? clipBox(selClip, playhead, stage.w, stage.h, W, H) : null;
  const keyframed = !!selClip?.keyframes && Object.keys(selClip.keyframes).length > 0;

  const dragBox = (mode: "move" | "scale") => (e: React.PointerEvent) => {
    if (!selClip || keyframed) return;
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const tr0 = { ...selClip.transform };
    beginTransient();
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (mode === "move") {
        updateClip(selTrackId, selClip.id, {
          transform: { ...tr0, x: Math.round(tr0.x + (dx / stage.w) * W), y: Math.round(tr0.y + (dy / stage.h) * H) },
        });
      } else {
        const ns = Math.max(0.1, tr0.scale + (dx / stage.w) * 2);
        updateClip(selTrackId, selClip.id, { transform: { ...tr0, scale: +ns.toFixed(3) } });
      }
    };
    const up = () => {
      commitTransient();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const dragRotate = (e: React.PointerEvent) => {
    if (!selClip || keyframed || !selBox) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = frameRef.current!.getBoundingClientRect();
    const cx = rect.left + selBox.left + selBox.vw / 2;
    const cy = rect.top + selBox.top + selBox.vh / 2;
    const tr0 = { ...selClip.transform };
    beginTransient();
    const move = (ev: PointerEvent) => {
      let deg = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      deg = Math.round(((((deg + 180) % 360) + 360) % 360) - 180); // normalize to -180..180
      updateClip(selTrackId, selClip.id, { transform: { ...tr0, rotation: deg } });
    };
    const up = () => {
      commitTransient();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Follows keyframed rotation so the selection box stays glued to the clip.
  const selRot = selBox?.rotation || 0;
  const handle = "absolute h-2.5 w-2.5 rounded-[2px] bg-background border border-brand shadow-[0_0_0_1px_rgba(0,0,0,0.5)]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
        style={{ background: "radial-gradient(ellipse at center, var(--stage), var(--stage-2))" }}
      >
        <div
          className="relative shadow-[0_20px_80px_-20px_rgba(0,0,0,0.8)] transition-[width,height] duration-300"
          style={{
            aspectRatio: ratio,
            height: aspect === "16:9" ? "auto" : "min(100%, 62vh)",
            width: aspect === "16:9" ? "min(100%, 80%)" : "auto",
            maxHeight: "100%",
            maxWidth: "100%",
          }}
        >
          <div ref={frameRef} className="absolute inset-0 overflow-hidden rounded-lg" style={{ background: bg }}>
            {visuals.map(({ track, clip }) => {
              const box = clipBox(clip, playhead, stage.w, stage.h, W, H);
              if (clip.title) {
                const t = clip.title;
                const fs = (t.size * box.vh) / 1080;
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      left: box.left,
                      top: box.top,
                      width: box.vw,
                      height: box.vh,
                      opacity: box.opacity,
                      overflow: "hidden",
                      pointerEvents: "none",
                      transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        top: t.posY * box.vh,
                        transform: "translateY(-50%)",
                        width: "100%",
                        boxSizing: "border-box",
                        padding: "0.2em 5%",
                        textAlign: t.align || "center",
                        color: t.color,
                        fontSize: fs,
                        fontWeight: t.bold ? 800 : 600,
                        lineHeight: 1.2,
                        background: t.background || "transparent",
                        textShadow: "0 2px 6px rgba(0,0,0,.9), 0 0 2px rgba(0,0,0,.9)",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {revealedText(t.text, t.reveal, playhead - clip.start, clipPlayDur(clip))}
                    </div>
                  </div>
                );
              }
              const asset = doc.assets.find((a) => a.id === clip.assetId);
              if (!asset) return null;
              const rot = box.rotation;
              const style = {
                width: box.vw,
                height: box.vh,
                left: box.left,
                top: box.top,
                opacity: box.opacity,
                filter: cssFilter(clip.effects, stage.h, H),
                transform: rot ? `rotate(${rot}deg)` : undefined,
              };
              if (asset.kind === "image") {
                return <img key={clip.id} src={mediaUrl(asset.path, asset.createdAt)} style={{ position: "absolute", ...style, objectFit: "contain" }} />;
              }
              return (
                <video
                  key={clip.id}
                  ref={(el) => (videoRefs.current[clip.id] = el)}
                  src={mediaUrl(asset.path, asset.createdAt)}
                  muted={!!track.muted || (soloActive && !track.solo) || !!clip.mute}
                  playsInline
                  style={{ position: "absolute", ...style }}
                />
              );
            })}

            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

            {audios.map(({ clip }) => {
              const asset = doc.assets.find((a) => a.id === clip.assetId);
              if (!asset) return null;
              return <audio key={clip.id} ref={(el) => (audioRefs.current[clip.id] = el)} src={mediaUrl(asset.path, asset.createdAt)} preload="auto" />;
            })}

            <div className="pointer-events-none absolute inset-[4%] rounded border border-dashed border-white/12" />

            {selBox && (
              <div
                onPointerDown={dragBox("move")}
                className={cn("absolute ring-1 ring-brand", keyframed ? "cursor-not-allowed" : "cursor-move")}
                style={{ left: selBox.left, top: selBox.top, width: selBox.vw, height: selBox.vh, transform: selRot ? `rotate(${selRot}deg)` : undefined }}
                title={keyframed ? "Keyframed — edit motion in the Inspector" : "Drag to move · corner to scale · top knob to rotate"}
              >
                {!keyframed && (
                  <>
                    <span className={cn(handle, "-left-1 -top-1")} />
                    <span className={cn(handle, "-right-1 -top-1")} />
                    <span className={cn(handle, "-left-1 -bottom-1")} />
                    <span onPointerDown={dragBox("scale")} className={cn(handle, "-right-1 -bottom-1 cursor-nwse-resize")} />
                    <span className="absolute left-1/2 -top-7 h-6 w-px -translate-x-1/2 bg-brand/70" />
                    <span
                      onPointerDown={dragRotate}
                      title="Drag to rotate"
                      className="absolute left-1/2 -top-9 grid h-5 w-5 -translate-x-1/2 cursor-grab place-items-center rounded-full border border-brand bg-background text-brand active:cursor-grabbing"
                    >
                      <RotateCw className="h-3 w-3" />
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="flex h-11 shrink-0 items-center gap-3 border-y hairline bg-panel/60 px-3">
        <div className="flex items-center gap-1">
          <IconBtn title="Jump to start" onClick={() => setPlayhead(0)}><SkipBack className="h-4 w-4" /></IconBtn>
          <button
            onClick={() => setPlaying(!playing)}
            title={playing ? "Pause (space)" : "Play (space)"}
            className="grid h-8 w-8 place-items-center rounded-md bg-brand text-brand-foreground shadow-[0_4px_20px_-4px_var(--brand)] hover:bg-brand/90"
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>
          <IconBtn title="Jump to end" onClick={() => setPlayhead(total)}><SkipForward className="h-4 w-4" /></IconBtn>
        </div>

        <div className="tabular text-[12px] text-muted-foreground">
          <span className="text-foreground">{fmtTC(playhead)}</span>
          <span className="mx-1 text-muted-foreground/60">/</span>
          <span>{fmtTC(total)}</span>
        </div>

        <SeekBar total={total} />

        <AudioMeter level={level} />

        <div className="flex items-center gap-1.5">
          <Chip onClick={() => addCue()}><Captions className="h-3 w-3" /> Caption</Chip>
        </div>
      </div>
    </div>
  );
}

// SeekBar is the transport scrubber: click or drag anywhere to move the
// playhead — the aiming device for split (S) and caption timing.
function SeekBar({ total }: { total: number }) {
  const playhead = useStudio((s) => s.playhead);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const ref = useRef<HTMLDivElement>(null);

  const seekTo = (clientX: number) => {
    const el = ref.current;
    if (!el || total <= 0) return;
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    setPlayhead(frac * total);
  };
  const pct = total > 0 ? Math.min(100, (playhead / total) * 100) : 0;

  return (
    <div
      ref={ref}
      title="Click or drag to seek"
      onPointerDown={(e) => {
        ref.current?.setPointerCapture(e.pointerId);
        seekTo(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) seekTo(e.clientX);
      }}
      className="group relative h-8 min-w-16 flex-1 cursor-pointer"
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-panel-2" />
      <div className="absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-l-full bg-brand/60" style={{ width: `${pct}%` }} />
      <span
        className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand shadow-[0_0_10px_var(--brand)] transition-transform group-hover:scale-125"
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

function AudioMeter({ level }: { level: number }) {
  const lit = Math.round(level * 22);
  return (
    <div className="flex h-2 w-40 items-center gap-[2px] rounded-full bg-panel-2 p-0.5" title={`audio ${Math.round(level * 100)}%`}>
      {Array.from({ length: 22 }).map((_, i) => {
        const active = i < lit;
        const color = i < 12 ? "bg-signal" : i < 17 ? "bg-amber-400" : "bg-destructive";
        return <span key={i} className={cn("h-full flex-1 rounded-[1px]", active ? color : "bg-white/5")} />;
      })}
    </div>
  );
}

function Chip({ children, active, onClick }: { children: React.ReactNode; active?: boolean; onClick?: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border hairline bg-panel-2 px-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground",
        active && "border-brand/40 bg-brand-soft text-foreground"
      )}
    >
      {children}
    </button>
  );
}

// ───────────────────────────── Spine ──────────────────────────────────────

function SpineArea({
  doc,
  selection,
  expanded,
  onToggleExpand,
  onSelect,
  total,
}: {
  doc: EditDoc;
  selection: Selection;
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onSelect: (s: Selection) => void;
  total: number;
}) {
  const mutate = useStudio((s) => s.mutate);
  const addTitle = useStudio((s) => s.addTitle);
  const addTrack = useStudio((s) => s.addTrack);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [spineTrackId, setSpineTrackId] = useState<string>("");

  const videoTracks = doc.tracks.filter((t) => t.kind === "video");
  const track = videoTracks.find((t) => t.id === spineTrackId) || primaryTrack(doc);
  const clips = useMemo(() => [...(track?.clips ?? [])].sort((a, b) => a.start - b.start), [track]);

  // Reflow the spine to be contiguous from 0 in a given clip order.
  const reflow = (order: Clip[]) => {
    if (!track) return;
    mutate((d) => {
      const t = d.tracks.find((x) => x.id === track.id);
      if (!t?.clips) return;
      let cursor = 0;
      for (const oc of order) {
        const c = t.clips.find((x) => x.id === oc.id);
        if (!c) continue;
        c.start = +cursor.toFixed(3);
        cursor += clipPlayDur(c);
      }
    });
  };

  const reorder = (from: number, to: number) => {
    if (from === to || from < 0 || from >= clips.length) return;
    const next = [...clips];
    const [moved] = next.splice(from, 1);
    const insertAt = to > from ? to - 1 : to;
    next.splice(insertAt, 0, moved!);
    reflow(next);
  };

  const handleGapDragOver = (i: number) => (e: React.DragEvent) => {
    // Two drag flavours land here: internal spine reorders and asset drags
    // from the Media panel ("text/assetId"; types are lowercased by the DnD API).
    const assetDrag = e.dataTransfer.types.includes("text/assetid");
    if (draggingIndex === null && !assetDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = draggingIndex !== null ? "move" : "copy";
    if (dropIndex !== i) setDropIndex(i);
  };
  const handleGapDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    if (draggingIndex !== null) {
      reorder(draggingIndex, i);
    } else {
      const assetId = e.dataTransfer.getData("text/assetId");
      const asset = doc.assets.find((a) => a.id === assetId);
      if (asset && track) {
        if (asset.kind === "audio") {
          const prev = clips[i - 1];
          useStudio.getState().addClipToLane(assetId, prev ? clipEnd(prev) : 0);
        } else {
          useStudio.getState().insertAssetOnSpine(track.id, assetId, i);
        }
      }
    }
    setDraggingIndex(null);
    setDropIndex(null);
  };
  const clearDrag = () => {
    setDraggingIndex(null);
    setDropIndex(null);
  };

  const insertAt = (index: number) => {
    // New title clip lands on the overlay layer; drop it at the gap's time so it
    // reads as "inserted here". (Media inserts happen via the Media panel.)
    const at = index === 0 ? 0 : clipEnd(clips[index - 1]!);
    useStudio.getState().setPlayhead(at);
    addTitle();
  };

  return (
    <div className="scrollbar-thin flex h-[46%] min-h-0 shrink-0 flex-col overflow-y-auto border-t hairline bg-panel/40">
      <div className="flex items-center justify-between px-4 pt-3 pb-2">
        <div className="flex items-center gap-2">
          <div className="label-caps">Spine</div>
          <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] tabular text-muted-foreground">
            {clips.length} clips · {fmtDur(total)}
          </span>
          {videoTracks.length > 1 && (
            <div className="ml-1 flex items-center gap-0.5 rounded-md bg-panel-2 p-0.5">
              {videoTracks.map((t, i) => (
                <button
                  key={t.id}
                  onClick={() => setSpineTrackId(t.id)}
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    track?.id === t.id ? "bg-panel-3 text-foreground" : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {t.name || `Video ${i + 1}`}
                </button>
              ))}
            </div>
          )}
          <button
            onClick={() => addTrack("video")}
            title="Add a video track"
            className="grid h-5 w-5 place-items-center rounded border hairline bg-panel-2 text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-3 w-3" />
          </button>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="tabular">{fmtTC(useStudio.getState().playhead)}</span>
          <span className="h-2 w-2 rounded-full bg-brand shadow-[0_0_10px_var(--brand)]" />
        </div>
      </div>

      <div className="scrollbar-thin flex-1 overflow-x-auto overflow-y-auto px-3 pb-3">
        <div className="relative flex min-w-max items-start gap-0 pt-1" onDragEnd={clearDrag}>
          <Gap
            active={dropIndex === 0}
            dragging={draggingIndex !== null}
            onInsert={() => insertAt(0)}
            onDragOver={handleGapDragOver(0)}
            onDrop={handleGapDrop(0)}
            onDragLeave={() => setDropIndex((d) => (d === 0 ? null : d))}
          />
          {clips.map((clip, i) => (
            <div key={clip.id} className="flex items-start">
              <div
                draggable
                onDragStart={(e) => {
                  setDraggingIndex(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", clip.id);
                }}
                onDragEnd={clearDrag}
                className={cn("transition-opacity", draggingIndex === i && "opacity-40")}
              >
                <ClipBlock
                  doc={doc}
                  trackId={track!.id}
                  clip={clip}
                  expanded={!!expanded[clip.id]}
                  selection={selection}
                  onToggle={() => onToggleExpand(clip.id)}
                  onSelect={onSelect}
                />
              </div>
              <Gap
                active={dropIndex === i + 1}
                dragging={draggingIndex !== null}
                onInsert={() => insertAt(i + 1)}
                onDragOver={handleGapDragOver(i + 1)}
                onDrop={handleGapDrop(i + 1)}
                onDragLeave={() => setDropIndex((d) => (d === i + 1 ? null : d))}
              />
            </div>
          ))}
        </div>

        <GlobalLayers
          doc={doc}
          selection={selection}
          onSelect={onSelect}
          spineTrackId={track?.id}
          onPickSpineTrack={setSpineTrackId}
        />
      </div>
    </div>
  );
}

function Gap({
  active,
  dragging,
  onInsert,
  onDragOver,
  onDrop,
  onDragLeave,
}: {
  active: boolean;
  dragging: boolean;
  onInsert: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onDragLeave: () => void;
}) {
  return (
    <div onDragOver={onDragOver} onDrop={onDrop} onDragLeave={onDragLeave} className={cn("relative flex items-stretch", dragging ? "w-8" : "w-auto")}>
      <div
        className={cn(
          "pointer-events-none absolute inset-y-1 left-1/2 w-[3px] -translate-x-1/2 rounded-full transition-opacity",
          active ? "bg-brand opacity-100 shadow-[0_0_12px_var(--brand)]" : "opacity-0"
        )}
      />
      <InsertButton onInsert={onInsert} />
    </div>
  );
}

function InsertButton({ onInsert }: { onInsert: () => void }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button onClick={(e) => e.stopPropagation()} className="group relative mx-1 flex h-[92px] w-6 shrink-0 flex-col items-center justify-center">
          <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-hairline group-hover:bg-brand/40" />
          <span className="relative grid h-6 w-6 place-items-center rounded-full border hairline bg-panel-2 text-muted-foreground transition-all group-hover:scale-110 group-hover:border-brand/50 group-hover:bg-brand-soft group-hover:text-foreground">
            <Plus className="h-3.5 w-3.5" />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-52 p-1.5">
        <div className="label-caps px-2 pb-1 pt-1">Insert clip</div>
        <InsertItem icon={Library} label="Library" onClick={() => toast.info("Open the Library from the Media panel")} />
        <InsertItem icon={ImportIcon} label="Import" onClick={() => toast.info("Import from the Media panel")} />
        <InsertItem icon={Wand2} label="Generate" onClick={() => toast.info("Generate from the Plugins tab")} accent />
        <InsertItem icon={Type} label="Title" onClick={onInsert} />
      </PopoverContent>
    </Popover>
  );
}

function InsertItem({ icon: Icon, label, onClick, accent }: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void; accent?: boolean }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-panel-2">
      <Icon className={cn("h-4 w-4", accent ? "text-brand" : "text-muted-foreground")} />
      <span>{label}</span>
    </button>
  );
}

function ClipBlock({
  doc,
  trackId,
  clip,
  expanded,
  selection,
  onToggle,
  onSelect,
}: {
  doc: EditDoc;
  trackId: string;
  clip: Clip;
  expanded: boolean;
  selection: Selection;
  onToggle: () => void;
  onSelect: (s: Selection) => void;
}) {
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const isSelected = "clipId" in selection && selection.clipId === clip.id;
  const hue = hueFor(clip.id);
  const label = clip.title ? clip.title.text || "Title" : asset?.name || "Clip";

  const splitHere = (e: React.MouseEvent) => {
    e.stopPropagation();
    const st = useStudio.getState();
    const end = clip.start + clipPlayDur(clip);
    if (st.playhead <= clip.start + 0.05 || st.playhead >= end - 0.05) {
      toast.info("Scrub the playhead into this clip, then split.");
      return;
    }
    st.select(trackId, clip.id);
    st.splitAtPlayhead();
  };
  const duplicate = (e: React.MouseEvent) => {
    e.stopPropagation();
    useStudio.getState().duplicateClip(trackId, clip.id);
  };
  const remove = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Remove this clip?")) return;
    const st = useStudio.getState();
    st.beginTransient();
    st.removeClip(trackId, clip.id);
    st.reflowTrack(trackId);
    st.commitTransient();
  };

  return (
    <div className="shrink-0">
      <button
        onClick={() => onSelect({ kind: "clip", trackId, clipId: clip.id })}
        className={cn(
          "group relative flex w-[184px] items-stretch gap-2 rounded-lg border p-2 text-left transition-all",
          isSelected ? "border-brand/60 bg-panel-2 shadow-[0_0_0_1px_var(--brand)]" : "hairline bg-panel-2/60 hover:bg-panel-2"
        )}
      >
        <div
          className="relative h-[76px] w-[72px] shrink-0 overflow-hidden rounded-md"
          style={{ background: `linear-gradient(140deg, hsl(${hue} 60% 32%), hsl(${(hue + 30) % 360} 65% 14%))` }}
        >
          {asset?.thumbnail && <img src={mediaUrl(asset.thumbnail, asset.createdAt)} alt="" className="absolute inset-0 h-full w-full object-cover" />}
          {clip.title ? (
            <Type className="absolute right-1.5 top-1.5 h-3 w-3 text-white/70" />
          ) : (
            <VideoIcon className="absolute right-1.5 top-1.5 h-3 w-3 text-white/70" />
          )}
          <div className="absolute left-1.5 bottom-1.5 rounded bg-black/50 px-1 text-[9px] tabular text-white">{fmtDur(clipPlayDur(clip))}</div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-start justify-between">
            <div className="min-w-0 truncate text-[13px] font-medium">{label}</div>
            <GripVertical className="h-3.5 w-3.5 opacity-0 group-hover:opacity-40" />
          </div>
          <div className="mt-0.5 flex items-center justify-between">
            <span className="text-[10.5px] uppercase tracking-wider text-muted-foreground">{clip.title ? "title" : "clip"}</span>
            <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
              <span
                role="button"
                tabIndex={-1}
                title="Split at playhead (S)"
                onClick={splitHere}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground"
              >
                <Scissors className="h-3 w-3" />
              </span>
              <span
                role="button"
                tabIndex={-1}
                title="Duplicate clip"
                onClick={duplicate}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground"
              >
                <Copy className="h-3 w-3" />
              </span>
              <span
                role="button"
                tabIndex={-1}
                title="Remove clip (⌫)"
                onClick={remove}
                className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-destructive"
              >
                <Trash2 className="h-3 w-3" />
              </span>
            </span>
          </div>
          <div
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.stopPropagation();
                e.preventDefault();
                onToggle();
              }
            }}
            className="mt-auto flex items-center justify-center gap-1 rounded-md border hairline bg-panel/60 py-1 text-[11px] text-muted-foreground hover:bg-panel-3 hover:text-foreground"
          >
            {expanded ? (
              <>
                <ChevronDown className="h-3 w-3" /> Collapse
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" /> Expand
              </>
            )}
          </div>
        </div>
      </button>

      <div className={cn("grid overflow-hidden transition-[grid-template-rows] duration-300 ease-out", expanded ? "mt-1.5 grid-rows-[1fr]" : "grid-rows-[0fr]")}>
        <div className="min-h-0">
          <div className="space-y-1 rounded-lg border hairline bg-panel/40 p-1.5">
            <SubLane doc={doc} trackId={trackId} clip={clip} lane="video" selection={selection} onSelect={onSelect} />
            <SubLane doc={doc} trackId={trackId} clip={clip} lane="audio" selection={selection} onSelect={onSelect} />
            <SubLane doc={doc} trackId={trackId} clip={clip} lane="subtitle" selection={selection} onSelect={onSelect} />
          </div>
        </div>
      </div>
    </div>
  );
}

function SubLane({
  doc,
  trackId,
  clip,
  lane,
  selection,
  onSelect,
}: {
  doc: EditDoc;
  trackId: string;
  clip: Clip;
  lane: LaneKind;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const removeClip = useStudio((s) => s.removeClip);
  const updateClip = useStudio((s) => s.updateClip);
  const attachAudio = useStudio((s) => s.attachAudio);
  const isSelected = selection.kind === "lane" && selection.clipId === clip.id && selection.lane === lane;
  const hue = hueFor(clip.id);
  const meta = {
    video: { Icon: VideoIcon, label: "Vid" },
    audio: { Icon: Volume2, label: "Aud" },
    subtitle: { Icon: Captions, label: "Sub" },
  }[lane];
  const cue = cueForClip(captionTrack(doc)?.cues, clip);
  const detached = detachedAudioFor(doc, clip.id);
  const isMuted = !!clip.mute;
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const silent = asset?.hasAudio === false;

  return (
    <button
      onClick={() => onSelect({ kind: "lane", trackId, clipId: clip.id, lane })}
      className={cn(
        "group flex w-full items-center gap-2 rounded-md border border-transparent bg-panel-2/40 p-1.5 text-left transition-colors hover:bg-panel-2",
        isSelected && "border-brand/50 bg-brand-soft/40"
      )}
    >
      <div className="flex w-12 shrink-0 items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        <meta.Icon className="h-3 w-3" />
        <span>{meta.label}</span>
      </div>
      <div className="relative h-6 flex-1 overflow-hidden rounded">
        {lane === "video" &&
          (clip.title || !asset || !(asset.duration > 0) ? (
            <div className="h-full w-full" style={{ background: `repeating-linear-gradient(90deg, hsl(${hue} 45% 25%) 0 12px, hsl(${hue} 40% 18%) 12px 14px)` }} />
          ) : (
            <TrimBar trackId={trackId} clip={clip} srcDur={asset.duration} hue={hue} />
          ))}
        {lane === "audio" && (
          <>
            {silent ? (
              <div className="flex h-full items-center bg-panel-2 px-1.5">
                <span className="h-px flex-1 bg-hairline" />
              </div>
            ) : (
              <Waveform hue={hue} />
            )}
            {silent && (
              <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-panel-3 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
                no audio
              </span>
            )}
            {detached && !silent && (
              <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-brand-soft px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-brand">
                detached
              </span>
            )}
            {isMuted && !detached && !silent && (
              <span className="absolute right-1 top-1/2 -translate-y-1/2 rounded bg-panel-3 px-1 py-0.5 text-[8px] font-medium uppercase tracking-wider text-muted-foreground">
                muted
              </span>
            )}
          </>
        )}
        {lane === "subtitle" && (
          <div className="flex h-full items-center gap-1 bg-panel-2 px-1">
            <span className="truncate rounded bg-panel-3 px-1.5 py-0.5 text-[10px] text-foreground">
              {cue?.text || "no caption"}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100">
        {lane === "audio" && !detached && (
          <span
            role="button"
            tabIndex={-1}
            title={isMuted ? "Unmute clip audio" : "Mute clip audio"}
            onClick={(e) => {
              e.stopPropagation();
              updateClip(trackId, clip.id, { mute: !isMuted });
            }}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground"
          >
            {isMuted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />}
          </span>
        )}
        {lane === "audio" && detached && (
          <span
            role="button"
            tabIndex={-1}
            title="Re-embed audio into the clip"
            onClick={(e) => {
              e.stopPropagation();
              attachAudio(trackId, clip.id);
            }}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground"
          >
            <Link2 className="h-3 w-3" />
          </span>
        )}
        {lane === "video" && (
          <span
            role="button"
            tabIndex={-1}
            onClick={(e) => {
              e.stopPropagation();
              if (confirm("Remove this clip?")) removeClip(trackId, clip.id);
            }}
            className="grid h-5 w-5 place-items-center rounded text-muted-foreground hover:bg-panel-3 hover:text-foreground"
          >
            <Trash2 className="h-3 w-3" />
          </span>
        )}
      </div>
    </button>
  );
}

// TrimBar renders the clip's window into its source ([in, out] over the full
// asset duration) with draggable edge handles. Dragging trims live (one undo
// entry per gesture) and the spine reflows on release so clips stay contiguous.
function TrimBar({ trackId, clip, srcDur, hue }: { trackId: string; clip: Clip; srcDur: number; hue: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = useRef<null | "in" | "out">(null);

  const begin = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    drag.current = which;
    useStudio.getState().beginTransient();
    ref.current?.setPointerCapture(e.pointerId);
  };
  // The bar maps a virtual timeline of the source span plus draggable freeze
  // headroom, so the right handle can be pulled past the source end to add hold.
  const holdMax = Math.max(clip.hold ?? 0, srcDur, 8);
  const vTotal = srcDur + holdMax;
  const pct = (tt: number) => Math.max(0, Math.min(100, (tt / vTotal) * 100));

  const move = (e: React.PointerEvent) => {
    if (!drag.current || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(vTotal, ((e.clientX - r.left) / r.width) * vTotal));
    const st = useStudio.getState();
    const cur = st.doc?.tracks.find((x) => x.id === trackId)?.clips?.find((x) => x.id === clip.id);
    if (!cur) return;
    if (drag.current === "in") {
      st.updateClip(trackId, clip.id, { in: +Math.min(t, srcDur, cur.out - 0.1).toFixed(3) });
    } else if (t <= srcDur) {
      // Inside the source → trim the out point, no freeze.
      st.updateClip(trackId, clip.id, { out: +Math.max(t, cur.in + 0.1).toFixed(3), hold: undefined });
    } else {
      // Past the source end → play all source, then freeze the last frame.
      st.updateClip(trackId, clip.id, { out: +srcDur.toFixed(3), hold: +(t - srcDur).toFixed(3) });
    }
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    const st = useStudio.getState();
    st.reflowTrack(trackId);
    st.commitTransient();
  };

  const hold = clip.hold && clip.hold > 0 ? clip.hold : 0;
  const left = pct(clip.in);
  const contentRight = Math.max(left, pct(clip.out));
  const rightEdge = pct(clip.out + hold);

  return (
    <div ref={ref} onPointerMove={move} onPointerUp={end} onPointerCancel={end} className="relative h-full w-full bg-panel-2" title="Drag the edges to trim · pull the right edge past the end to freeze the last frame">
      <div
        className="absolute inset-y-0"
        style={{ left: `${left}%`, width: `${contentRight - left}%`, background: `repeating-linear-gradient(90deg, hsl(${hue} 45% 25%) 0 12px, hsl(${hue} 40% 18%) 12px 14px)` }}
      />
      {hold > 0 && (
        <div
          className="absolute inset-y-0 flex items-center justify-center overflow-hidden text-[8px] font-semibold uppercase tracking-wide text-white/70"
          style={{ left: `${contentRight}%`, width: `${rightEdge - contentRight}%`, background: `repeating-linear-gradient(45deg, hsl(${hue} 30% 30% / .55) 0 5px, hsl(${hue} 25% 18% / .55) 5px 10px)` }}
          title={`Freeze last frame · ${hold.toFixed(1)}s`}
        >
          ❄ freeze
        </div>
      )}
      <span
        onPointerDown={begin("in")}
        title="Trim start"
        className="absolute inset-y-0 z-10 w-1.5 cursor-ew-resize rounded-sm bg-brand/80 hover:bg-brand"
        style={{ left: `calc(${left}% - 3px)` }}
      />
      <span
        onPointerDown={begin("out")}
        title="Trim end · drag past the source end to freeze"
        className={cn("absolute inset-y-0 z-10 w-1.5 cursor-ew-resize rounded-sm hover:bg-brand", hold > 0 ? "bg-sky-400/80" : "bg-brand/80")}
        style={{ left: `calc(${rightEdge}% - 3px)` }}
      />
    </div>
  );
}

function Waveform({ hue }: { hue: number }) {
  const bars = useMemo(() => Array.from({ length: 60 }).map((_, i) => 0.25 + (Math.sin(i * 1.7) * 0.5 + 0.5) * 0.7), []);
  return (
    <div className="flex h-full items-center gap-[1px] bg-panel-2 px-1">
      {bars.map((b, i) => (
        <span key={i} className="flex-1 rounded-[1px]" style={{ height: `${b * 100}%`, background: `hsl(${hue} 65% ${45 + b * 15}%)` }} />
      ))}
    </div>
  );
}

// ─────────────────────────── Global layers ────────────────────────────────

// GlobalLayers is the layer stack: every visual track top-most first (the
// stacking the preview and exporter actually use — kind rank background <
// video < overlay, array order within a kind), plus the audio lanes. Each row
// carries the whole-track controls: raise/lower (z-order), hide, mute, solo,
// remove.
function GlobalLayers({
  doc,
  selection,
  onSelect,
  spineTrackId,
  onPickSpineTrack,
}: {
  doc: EditDoc;
  selection: Selection;
  onSelect: (s: Selection) => void;
  spineTrackId?: string;
  onPickSpineTrack?: (id: string) => void;
}) {
  const toggleTrackFlag = useStudio((s) => s.toggleTrackFlag);
  const addTrack = useStudio((s) => s.addTrack);
  const overlays = overlayTracksOf(doc).flatMap((t) => (t.clips ?? []).map((c) => ({ trackId: t.id, clip: c })));
  const bg = doc.tracks.find((t) => t.kind === "background");

  // Visual stack, front-most first: overlay tracks (reverse array order), then
  // video tracks (reverse), background at the very back.
  const overlayTracks = [...doc.tracks.filter((t) => t.kind === "overlay")].reverse();
  const videoTracks = [...doc.tracks.filter((t) => t.kind === "video")].reverse();
  const audioTracks = doc.tracks.filter((t) => t.kind === "audio");

  return (
    <div className="mt-4 space-y-1.5 rounded-lg border hairline bg-panel/30 p-2">
      <div className="flex items-center justify-between px-1 pb-0.5">
        <div className="label-caps flex items-center gap-1.5">
          <Layers className="h-3 w-3" /> Layers
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => addTrack("video")} className="rounded border hairline bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            + Video
          </button>
          <button onClick={() => addTrack("overlay")} className="rounded border hairline bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            + Overlay
          </button>
          <button onClick={() => addTrack("audio")} className="rounded border hairline bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground">
            + Audio
          </button>
        </div>
      </div>

      {overlayTracks.map((t) => (
        <TrackLayerRow key={t.id} doc={doc} track={t}>
          {(t.clips ?? []).length === 0 ? (
            <span className="flex h-full items-center px-2 text-[10.5px] text-muted-foreground">No overlays</span>
          ) : (
            overlays
              .filter((o) => o.trackId === t.id)
              .slice(0, 6)
              .map(({ trackId, clip }, i) => {
                const sel = selection.kind === "overlay" && selection.clipId === clip.id;
                return (
                  <div
                    key={clip.id}
                    onClick={() => onSelect({ kind: "overlay", trackId, clipId: clip.id })}
                    className={cn(
                      "absolute inset-y-1 cursor-pointer truncate rounded bg-gradient-to-r from-brand/70 to-brand/40 px-2 py-0.5 text-[10.5px] font-medium text-white shadow",
                      sel && "ring-1 ring-brand"
                    )}
                    style={{ left: `${2 + i * 22}%`, width: "20%" }}
                  >
                    {clip.title?.text || "overlay"}
                  </div>
                );
              })
          )}
        </TrackLayerRow>
      ))}

      {videoTracks.map((t) => (
        <TrackLayerRow key={t.id} doc={doc} track={t}>
          <button
            onClick={() => onPickSpineTrack?.(t.id)}
            className={cn(
              "flex h-full w-full items-center px-2 text-left text-[10.5px]",
              spineTrackId === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            )}
            title="Edit this track in the spine"
          >
            {(t.clips ?? []).length} clips · {fmtDur((t.clips ?? []).reduce((s, c) => Math.max(s, c.start + clipPlayDur(c)), 0))}
            {spineTrackId === t.id && <span className="ml-2 rounded bg-brand-soft px-1 py-0.5 text-[9px] uppercase tracking-wider text-brand">in spine</span>}
          </button>
        </TrackLayerRow>
      ))}

      {bg && (
        <div className="flex items-center gap-2 px-1 py-0.5 text-[10.5px] text-muted-foreground">
          <span className="ml-1 h-3 w-3 shrink-0 rounded-sm border hairline" style={{ background: bg.backgroundColor || "#000" }} />
          <span className="w-40 shrink-0">Background</span>
          <span>always at the back — color in Project settings</span>
        </div>
      )}

      <div className="!mt-2.5 border-t hairline pt-1.5" />

      {audioTracks.length === 0 ? (
        <div className="px-2 text-[10.5px] text-muted-foreground">No audio tracks</div>
      ) : (
        audioTracks.map((t) => (
          <TrackLayerRow
            key={t.id}
            doc={doc}
            track={t}
            rightSlot={
              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Duck</span>
                <Switch checked={!!t.duck} onCheckedChange={() => toggleTrackFlag(t.id, "duck")} className="scale-75" />
              </div>
            }
          >
            <button
              onClick={() => onSelect({ kind: "soundtrack", trackId: t.id })}
              className={cn(
                "flex h-full w-full items-center px-2 text-left text-[10.5px]",
                selection.kind === "soundtrack" && selection.trackId === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {(t.clips ?? []).length} clips
            </button>
          </TrackLayerRow>
        ))
      )}
    </div>
  );
}

// TrackLayerRow is one row of the layer stack: name + content strip + the
// track-wide controls (z-order, hide, mute, solo, remove).
function TrackLayerRow({
  doc,
  track,
  children,
  rightSlot,
}: {
  doc: EditDoc;
  track: Track;
  children: React.ReactNode;
  rightSlot?: React.ReactNode;
}) {
  const moveTrackZ = useStudio((s) => s.moveTrackZ);
  const toggleTrackFlag = useStudio((s) => s.toggleTrackFlag);
  const removeTrack = useStudio((s) => s.removeTrack);
  const isAudio = track.kind === "audio";
  const Icon = isAudio ? Music2 : track.kind === "overlay" ? Layers : VideoIcon;
  const siblings = doc.tracks.filter((t) => t.kind === track.kind).length;

  // Asset kinds this track row accepts on drop: audio → audio tracks, visual
  // media → video tracks. Drops append the asset as a clip at the track's end.
  const [dropOk, setDropOk] = useState(false);
  const accepts = track.kind === "audio" ? ["audio"] : track.kind === "video" ? ["video", "image"] : [];
  const canDrop = (dt: DataTransfer) => accepts.some((k) => dt.types.includes(`asset/${k}`));
  const onLaneDragOver = (e: React.DragEvent) => {
    if (!canDrop(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!dropOk) setDropOk(true);
  };
  const onLaneDrop = (e: React.DragEvent) => {
    setDropOk(false);
    if (!canDrop(e.dataTransfer)) return;
    e.preventDefault();
    const assetId = e.dataTransfer.getData("text/assetId");
    if (assetId) useStudio.getState().insertAssetOnSpine(track.id, assetId, track.clips?.length ?? 0);
  };

  const iconBtn = (title: string, active: boolean, onClick: () => void, child: React.ReactNode) => (
    <button
      title={title}
      onClick={onClick}
      className={cn(
        "grid h-5 w-5 place-items-center rounded hover:bg-panel-3",
        active ? "text-brand" : "text-muted-foreground hover:text-foreground"
      )}
    >
      {child}
    </button>
  );

  return (
    <div className={cn("flex items-center gap-2", (track.hidden || track.muted) && "opacity-60")}>
      <div className="flex w-40 shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground">
        <Icon className="h-3 w-3 shrink-0" />
        <span className="truncate">{track.name || track.kind}</span>
      </div>
      <div
        onDragOver={accepts.length ? onLaneDragOver : undefined}
        onDrop={accepts.length ? onLaneDrop : undefined}
        onDragLeave={() => dropOk && setDropOk(false)}
        className={cn("relative h-6 flex-1 overflow-hidden rounded bg-panel-2/50", dropOk && "ring-1 ring-brand bg-brand-soft")}
      >
        {children}
      </div>
      {rightSlot && <div className="shrink-0">{rightSlot}</div>}
      <div className="flex shrink-0 items-center gap-0.5">
        {!isAudio && siblings > 1 && (
          <>
            {iconBtn("Bring forward", false, () => moveTrackZ(track.id, +1), <ChevronUp className="h-3 w-3" />)}
            {iconBtn("Send backward", false, () => moveTrackZ(track.id, -1), <ChevronDown className="h-3 w-3" />)}
          </>
        )}
        {!isAudio &&
          iconBtn(track.hidden ? "Show layer" : "Hide layer", !!track.hidden, () => toggleTrackFlag(track.id, "hidden"), track.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />)}
        {iconBtn(track.muted ? "Unmute track" : "Mute track", !!track.muted, () => toggleTrackFlag(track.id, "muted"), track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />)}
        {iconBtn(track.solo ? "Unsolo" : "Solo (only this track's audio)", !!track.solo, () => toggleTrackFlag(track.id, "solo"), <span className="text-[9px] font-bold">S</span>)}
        {iconBtn("Remove track (and its clips)", false, () => {
          const n = track.clips?.length ?? 0;
          if (n === 0 || confirm(`Remove "${track.name || track.kind}" and its ${n} clip${n === 1 ? "" : "s"}?`)) removeTrack(track.id);
        }, <Trash2 className="h-3 w-3" />)}
      </div>
    </div>
  );
}

// ───────────────────────────── Inspector ──────────────────────────────────

function Inspector({ doc, selection, onSelect }: { doc: EditDoc; selection: Selection; onSelect: (s: Selection) => void }) {
  const removeClip = useStudio((s) => s.removeClip);
  const removeCue = useStudio((s) => s.removeCue);

  const clip = "clipId" in selection ? findClip(doc, selection.trackId, selection.clipId) : undefined;
  const trackId = "trackId" in selection ? selection.trackId : "";
  const cue = clip ? cueForClip(captionTrack(doc)?.cues, clip) : undefined;
  const soloCue = selection.kind === "cue" ? captionTrack(doc)?.cues?.find((c) => c.id === selection.cueId) : undefined;

  let title = "Project";
  let sub = "Global settings";
  if (selection.kind === "clip" && clip) {
    title = clip.title ? "Title clip" : "Clip";
    sub = `${fmtDur(clipPlayDur(clip))} · ${clip.title ? "text" : "media"}`;
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
        {selection.kind === "clip" && clip && !clip.title && <ClipInspector trackId={trackId} clip={clip} />}
        {selection.kind === "clip" && clip && clip.title && <TitleInspector trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "video" && <ClipInspector trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "audio" && <AudioInspector doc={doc} trackId={trackId} clip={clip} />}
        {selection.kind === "lane" && clip && selection.lane === "subtitle" && <SubtitleInspector clip={clip} cue={cue} />}
        {selection.kind === "overlay" && clip && <TitleInspector trackId={trackId} clip={clip} />}
        {selection.kind === "soundtrack" && <SoundtrackInspector doc={doc} trackId={trackId} />}
        {selection.kind === "cue" && soloCue && <SubtitleInspector cue={soloCue} />}
        {selection.kind === "none" && <ProjectInspector doc={doc} />}

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

function Section({ label, children, defaultOpen = true }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border hairline bg-panel-2/40">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between px-2.5 py-2">
        <span className="label-caps">{label}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
      </button>
      {open && <div className="space-y-2.5 px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</label>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function NumInput({ value, onChange, step = 1, suffix, min, max }: { value: number; onChange: (v: number) => void; step?: number; suffix?: string; min?: number; max?: number }) {
  const [t, setT] = useState(String(value));
  useEffect(() => setT(String(value)), [value]);
  const commit = () => {
    let v = parseFloat(t);
    if (isNaN(v)) v = value;
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    onChange(v);
  };
  return (
    <div className="flex items-center rounded-md border hairline bg-panel-2 px-2">
      <input
        value={t}
        inputMode="decimal"
        step={step}
        onChange={(e) => setT(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        className="tabular h-7 w-full bg-transparent text-[12px] outline-none"
      />
      {suffix && <span className="text-[10px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}

function SliderRow({ label, value, min = 0, max = 100, step = 1, onChange, fmt }: { label: string; value: number; min?: number; max?: number; step?: number; onChange: (v: number) => void; fmt?: (v: number) => string }) {
  return (
    <div className="flex items-center gap-2">
      <label className="w-16 shrink-0 text-[11px] text-muted-foreground">{label}</label>
      <Slider value={[value]} onValueChange={(x) => onChange(x[0]!)} min={min} max={max} step={step} className="flex-1" />
      <span className="w-9 text-right text-[11px] tabular text-muted-foreground">{fmt ? fmt(value) : Math.round(value)}</span>
    </div>
  );
}

function ColorSwatch({ color, onChange }: { color: string; onChange?: (c: string) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md border hairline bg-panel-2 px-2 py-1">
      <span className="relative h-4 w-4 overflow-hidden rounded border hairline" style={{ background: color }}>
        {onChange && (
          <input type="color" value={color} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
        )}
      </span>
      <span className="tabular text-[11px] uppercase text-muted-foreground">{color}</span>
    </label>
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

      {asset?.hasCursor && <SmartFocusSection trackId={trackId} clip={clip} assetId={asset.id} />}
      {asset?.hasCursor && (
        <CursorFXSection trackId={trackId} clip={clip} ownsCursor={!!asset.cursorHidden} />
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

function ProjectInspector({ doc }: { doc: EditDoc }) {
  const setBackground = useStudio((s) => s.setBackground);
  const mutate = useStudio((s) => s.mutate);
  const bg = doc.tracks.find((t) => t.kind === "background")?.backgroundColor || "#0c0d10";
  return (
    <Section label="Project">
      <Field label="Aspect"><span className="text-[12px] text-muted-foreground tabular">{aspectOf(doc.canvas)}</span></Field>
      <Field label="BG"><ColorSwatch color={bg} onChange={(c) => setBackground(c)} /></Field>
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
    </Section>
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
