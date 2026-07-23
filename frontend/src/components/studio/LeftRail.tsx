import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  Circle,
  Library,
  Import as ImportIcon,
  Wand2,
  Video as VideoIcon,
  Music2,
  Image as ImageIcon,
  X,
  Package,
  RotateCw,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { RecordPanel } from "./RecordPanel";
import { TranscriptPanel } from "./TranscriptPanel";
import { ChaptersSection } from "./ChaptersSection";
import { BrollSuggestions } from "./BrollSuggestions";
import { PluginDocEditor } from "./PluginDocEditor";
import type { Selection } from "./selection";
import { captionTrack, hueFor } from "./bridge";
import { useStudio } from "../../state";
import type {
  AppStatus,
  Asset,
  CaptionCue,
  EditDoc,
  GeneratorStatus,
  LibraryEntry,
  ParamSpec,
  PluginState,
} from "../../types";
import { assetLabel, mediaUrl } from "../../types";
import { SAMPLES } from "../../generatorSamples";
import { api } from "../../api";
import { loadPluginPrefs, savePluginPrefs, recentPluginIds } from "../../pluginPrefs";
import { CAPTION_PRESETS, applyCaptionPresetStyle } from "../../captionPresets";
import { parseDoc, seedDoc, serializeDoc, type Doc } from "../../pluginDoc";
import { toast } from "../../toast";
import { awaitJob } from "../../jobs";
import { AppStudio } from "../AppStudio";
import { LibraryModal } from "../LibraryModal";
import type { PostRecordSummary } from "./PostRecordChecklist";

// ───────────────────────────── Left rail ──────────────────────────────────

export function LeftRail({
  projectId,
  doc,
  onSelect,
  onExport,
  onEnterReview,
}: {
  projectId: string;
  doc: EditDoc;
  onSelect: (s: Selection) => void;
  onExport: () => void;
  onEnterReview: (summary: PostRecordSummary) => void;
}) {
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
          <MediaPanel projectId={projectId} doc={doc} onExport={onExport} onEnterReview={onEnterReview} />
        </TabsContent>

        <TabsContent value="captions" className="mt-0 flex min-h-0 flex-1 flex-col">
          <CaptionsPanel projectId={projectId} doc={doc} onSelect={onSelect} />
        </TabsContent>

        <TabsContent value="plugins" className="mt-0 flex min-h-0 flex-1 flex-col">
          <PluginsPanel projectId={projectId} doc={doc} />
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
  const setCues = useStudio((s) => s.setCues);
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [whisper, setWhisper] = useState<{ transcribe: boolean; transcribeError: string } | null>(null);

  useEffect(() => {
    api.capabilities().then(setWhisper).catch(() => {});
  }, []);

  const cues = captionTrack(doc)?.cues ?? [];
  const audible = doc.assets.filter((a) => a.kind !== "image");

  const applyPresetToAll = (presetId: string) => {
    const preset = CAPTION_PRESETS.find((p) => p.id === presetId);
    if (!preset || cues.length === 0) return;
    setCues(cues.map((c) => ({ ...c, style: applyCaptionPresetStyle(c.style, preset) })));
    toast.success(`Applied "${preset.name}" to ${cues.length} cue${cues.length === 1 ? "" : "s"}`);
  };

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
        {cues.length > 0 && (
          <div className="mt-2">
            <div className="mb-1 text-[10px] font-medium text-muted-foreground">Style presets</div>
            <div className="flex flex-wrap gap-1">
              {CAPTION_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  title={p.description}
                  onClick={() => applyPresetToAll(p.id)}
                  className="rounded-md border hairline bg-panel-2 px-2 py-1 text-[10px] hover:bg-panel-3"
                >
                  <span className="mr-1 inline-block h-2 w-2 rounded-full align-middle" style={{ background: p.swatch }} />
                  {p.name}
                </button>
              ))}
            </div>
          </div>
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
      <TranscriptPanel doc={doc} onSelectCue={(cueId) => onSelect({ kind: "cue", cueId })} />
      <ChaptersSection doc={doc} projectId={projectId} />
    </>
  );
}

function MediaPanel({
  projectId,
  doc,
  onExport,
  onEnterReview,
}: {
  projectId: string;
  doc: EditDoc;
  onExport: () => void;
  onEnterReview: (summary: PostRecordSummary) => void;
}) {
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
        <RecordPanel
          projectId={projectId}
          onClose={() => setRecording(false)}
          onExport={onExport}
          onEnterReview={(summary) => {
            setRecording(false);
            onEnterReview(summary);
          }}
        />
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
        <LibraryModal
          projectId={projectId}
          onClose={() => setLib(false)}
          onImported={(a) => {
            addAsset(a);
            void autoTranscribe(projectId, a);
          }}
        />
      )}
    </>
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
          <div className="truncate text-[13px] font-medium">{assetLabel(asset)}</div>
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
          if (confirm(`Remove "${assetLabel(asset)}" and any clips using it?`)) onRemove();
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

function PluginsPanel({ projectId, doc }: { projectId: string; doc: EditDoc }) {
  const addAsset = useStudio((s) => s.addAsset);
  const addClipToLane = useStudio((s) => s.addClipToLane);
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  const [apps, setApps] = useState<Record<string, AppStatus>>({});
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [studioFor, setStudioFor] = useState<AppStatus | null>(null);
  const [genFor, setGenFor] = useState<string | null>(null);
  const [brollAt, setBrollAt] = useState<number | null>(null);
  const recent = recentPluginIds(3);
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
      <BrollSuggestions
        doc={doc}
        onGenerate={(start) => {
          setBrollAt(start);
          const hyper = gens.find((g) => /hyper|frame|broll|intro/i.test(g.id + g.name));
          if (hyper) setGenFor(hyper.id);
        }}
      />
      {recent.length > 0 && gens.length > 0 && (
        <div className="px-3 pb-2">
          <div className="mb-1 text-[10px] font-medium text-muted-foreground">Recent</div>
          <div className="flex flex-wrap gap-1">
            {recent.map((id) => {
              const g = gens.find((x) => x.id === id);
              if (!g) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className="rounded border hairline bg-panel-2 px-2 py-0.5 text-[10px] hover:bg-panel-3"
                  onClick={() => setGenFor(genFor === id ? null : id)}
                >
                  {g.name}
                </button>
              );
            })}
          </div>
        </div>
      )}
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
                    <GenerateForm projectId={projectId} gen={g} brollAt={brollAt} onDone={onGenerated} />
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
  brollAt,
}: {
  projectId: string;
  gen: GeneratorStatus;
  onDone: (asset: Asset | null) => Promise<void> | void;
  brollAt?: number | null;
}) {
  const hasSchema = !!gen.fields?.length;
  const [doc, setDoc] = useState<Doc>(() => seedDoc(parseDoc(undefined, gen.docRoot), gen.fields ?? []));
  const [input, setInput] = useState(() => SAMPLES[gen.inputKind] ?? "");
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const setPlayhead = useStudio((s) => s.setPlayhead);

  useEffect(() => {
    const prefs = loadPluginPrefs(gen.id);
    if (!prefs) return;
    if (prefs.input) setInput(prefs.input);
    if (prefs.docJson && hasSchema) {
      try {
        setDoc(parseDoc(prefs.docJson, gen.docRoot));
      } catch {
        /* ignore stale prefs */
      }
    }
    if (prefs.params) setParams(prefs.params);
  }, [gen.id, gen.docRoot, hasSchema]);

  const setParam = (flag: string, v: string) => setParams((p) => ({ ...p, [flag]: v }));

  const restoreLast = () => {
    const prefs = loadPluginPrefs(gen.id);
    if (!prefs) {
      toast.info("No saved settings for this plugin yet.");
      return;
    }
    if (prefs.input) setInput(prefs.input);
    if (prefs.docJson && hasSchema) setDoc(parseDoc(prefs.docJson, gen.docRoot));
    if (prefs.params) setParams(prefs.params);
    toast.success("Restored last settings");
  };

  const run = async () => {
    const payload = hasSchema ? serializeDoc(doc) : input;
    if (!payload.trim()) {
      toast.error("Input is empty.");
      return;
    }
    savePluginPrefs(gen.id, {
      input: hasSchema ? undefined : input,
      docJson: hasSchema ? payload : undefined,
      params,
    });
    setBusy(true);
    try {
      const { jobId } = await api.generate(projectId, gen.id, payload, params);
      const data = await awaitJob(jobId);
      const asset = (data?.asset as Asset) ?? null;
      if (brollAt != null) setPlayhead(brollAt);
      await onDone(asset);
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
      <div className="flex gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 flex-1 bg-panel-3 text-xs"
          disabled={busy}
          onClick={restoreLast}
        >
          Last settings
        </Button>
        <Button
          size="sm"
          className="h-7 flex-[2] bg-brand text-xs text-brand-foreground hover:bg-brand/90 disabled:opacity-40"
          disabled={busy}
          onClick={run}
        >
          <Wand2 className="mr-1 h-3.5 w-3.5" /> {busy ? "Generating…" : brollAt != null ? "Generate → gap" : "Generate → timeline"}
        </Button>
      </div>
    </div>
  );
}

export function ParamControl({ spec, value, onChange }: { spec: ParamSpec; value: string; onChange: (v: string) => void }) {
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
