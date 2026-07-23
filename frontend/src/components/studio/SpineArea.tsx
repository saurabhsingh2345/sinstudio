import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Plus,
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
  Layers,
  Trash2,
  Eye,
  EyeOff,
  GripVertical,
} from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import type { EditDoc, Clip, Track } from "../../types";
import { clipPlayDur, mediaUrl } from "../../types";
import { toast } from "../../toast";
import { trackBackgroundCSS } from "../../trackBackground";
import type { LaneKind, Selection } from "./selection";
import {
  captionTrack,
  clipEnd,
  cueForClip,
  detachedAudioFor,
  fmtDur,
  fmtTC,
  hueFor,
  primaryTrack,
  overlayTracks as overlayTracksOf,
} from "./bridge";

// ───────────────────────────── Spine ──────────────────────────────────────

export function SpineArea({
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
          <span className="ml-1 h-3 w-3 shrink-0 rounded-sm border hairline" style={{ background: trackBackgroundCSS(bg) }} />
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

