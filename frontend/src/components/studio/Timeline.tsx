// Timeline — a Premiere-style, time-scaled multitrack editor that replaces the
// card "spine" as the default bottom editor. Every track gets its own horizontal
// lane; clips are drawn to scale (start·pxPerSec wide) and can be dragged to
// move (horizontally in time, vertically across same-kind lanes), trimmed by
// their edges (extending a source past its end freezes the last frame), split at
// the playhead, zoomed, and snapped to neighbours/the playhead/markers.
//
// It is a pure view over the same EditDoc/store the rest of the editor uses — no
// new schema. Deep per-clip customization still lives in the right Inspector.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Scissors,
  Trash2,
  Magnet,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Focus,
  MapPin,
  Eye,
  EyeOff,
  Volume2,
  VolumeX,
  Video as VideoIcon,
  Music2,
  Layers,
  Captions,
  Type,
  ChevronUp,
  ChevronDown,
  Copy,
  Link2,
  RotateCcw,
  Lock,
  Unlock,
  ArrowLeftRight,
  Gauge,
  Ban,
  Blend,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import type { Clip, EditDoc, Track } from "../../types";
import { clipPlayDur, clipSrcDur, mediaUrl } from "../../types";
import { getPeaks, peaksNow } from "../../peaks";
import { hueFor, fmtTC } from "./bridge";
import type { Selection } from "./selection";
import { findClip } from "./selection";

const HEADER_W = 132; // fixed left track-header column
const RULER_H = 26;
const SNAP_PX = 7; // pointer distance (px) inside which the moving edge snaps
const TRIM_PX = 8; // grab zone at each clip edge
// Zoom-to-clip frames the clip to ~this fraction of the viewport rather than
// filling it — filling read as "too big". At 0.1 the clip sits at ~10% width
// with generous context on both sides, like the clip-focus zoom in other editors.
const CLIP_ZOOM_FRAC = 0.1;

const ROW_H: Record<Track["kind"], number> = {
  overlay: 46,
  video: 62,
  audio: 54,
  caption: 36,
  background: 34,
};

const kindMeta: Record<string, { Icon: React.ComponentType<{ className?: string }>; label: string }> = {
  overlay: { Icon: Layers, label: "Overlay" },
  video: { Icon: VideoIcon, label: "Video" },
  audio: { Icon: Music2, label: "Audio" },
  caption: { Icon: Captions, label: "Captions" },
};

// ─────────────────────────────── root ─────────────────────────────────────

export function Timeline({
  doc,
  selection,
  onSelect,
  total,
}: {
  doc: EditDoc;
  selection: Selection;
  onSelect: (s: Selection) => void;
  total: number;
}) {
  const px = useStudio((s) => s.pxPerSec);
  const setZoom = useStudio((s) => s.setZoom);
  const playhead = useStudio((s) => s.playhead);
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const snapLine = useStudio((s) => s.snapLine);
  const addTrack = useStudio((s) => s.addTrack);
  const addMarker = useStudio((s) => s.addMarker);
  const splitAtPlayhead = useStudio((s) => s.splitAtPlayhead);
  const deleteSelected = useStudio((s) => s.deleteSelected);

  const playing = useStudio((s) => s.playing);

  const [snap, setSnap] = useState(true);
  const [ripple, setRipple] = useState(false);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [menu, setMenu] = useState<ClipMenu | null>(null);

  // #8 Per-track view prefs (collapse + lock) — UI-only, persisted per project.
  const prefKey = `tl-prefs-${doc.id}`;
  const [prefs, setPrefs] = useState<{ collapsed: Record<string, boolean>; locked: Record<string, boolean> }>(() => {
    try {
      const p = JSON.parse(localStorage.getItem(prefKey) || "");
      return { collapsed: p.collapsed || {}, locked: p.locked || {} };
    } catch {
      return { collapsed: {}, locked: {} };
    }
  });
  useEffect(() => {
    localStorage.setItem(prefKey, JSON.stringify(prefs));
  }, [prefKey, prefs]);
  const toggleCollapse = (id: string) => setPrefs((p) => ({ ...p, collapsed: { ...p.collapsed, [id]: !p.collapsed[id] } }));
  const toggleLock = (id: string) => setPrefs((p) => ({ ...p, locked: { ...p.locked, [id]: !p.locked[id] } }));
  const scrollRef = useRef<HTMLDivElement>(null);
  const rulerStripRef = useRef<HTMLDivElement>(null);
  // trackId → lane element, for vertical (cross-track) hit-testing during a drag.
  const laneEls = useRef<Map<string, HTMLDivElement>>(new Map());

  // #1 Auto-scroll: keep the playhead in view. During playback it pages forward
  // when the playhead reaches the right edge; on a manual seek that lands
  // off-screen it recenters. Only scrolls when the playhead is actually outside
  // the visible lane window, so it never fights manual scrolling.
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return;
    const ph = playhead * px;
    const viewLeft = sc.scrollLeft;
    const viewRight = sc.scrollLeft + sc.clientWidth - HEADER_W;
    if (ph < viewLeft || ph > viewRight - 2) {
      sc.scrollLeft = playing ? Math.max(0, ph - 48) : Math.max(0, ph - (sc.clientWidth - HEADER_W) / 2);
    }
  }, [playhead, playing, px]);

  // Display order, top → bottom: overlays (front-most first), then video tracks
  // (front-most first), then audio tracks, then the caption track. This mirrors
  // the compositing z-order the preview/export use (kind rank background < video
  // < overlay, later array index = on top), read top-down.
  const rows = useMemo<Track[]>(() => {
    const overlay = doc.tracks.filter((t) => t.kind === "overlay").reverse();
    const video = doc.tracks.filter((t) => t.kind === "video").reverse();
    const audio = doc.tracks.filter((t) => t.kind === "audio");
    const caption = doc.tracks.find((t) => t.kind === "caption");
    return [...overlay, ...video, ...audio, ...(caption ? [caption] : [])];
  }, [doc.tracks]);

  const tail = 4;
  const contentDur = Math.max(total, playhead, 10) + tail;
  const contentW = contentDur * px;

  // Snap candidates (seconds) — every other clip edge, the playhead, 0, and
  // markers. Rebuilt per render (cheap; clip counts are small).
  const snapCandidates = (excludeClipId?: string): number[] => {
    const out = new Set<number>([0, +playhead.toFixed(3)]);
    for (const t of doc.tracks)
      for (const c of t.clips || []) {
        if (c.id === excludeClipId) continue;
        out.add(+c.start.toFixed(3));
        out.add(+clipEnd(c).toFixed(3));
      }
    for (const m of doc.markers || []) out.add(+m.t.toFixed(3));
    return [...out];
  };

  // timeAt maps a clientX to a timeline second using the ruler strip's live
  // on-screen rect (which already reflects horizontal scroll).
  const timeAt = (clientX: number): number => {
    const r = rulerStripRef.current?.getBoundingClientRect();
    if (!r) return 0;
    return Math.max(0, (clientX - r.left) / px);
  };

  // scrubbing on the ruler
  const scrub = (e: React.PointerEvent) => {
    e.preventDefault();
    const to = (ev: PointerEvent | React.PointerEvent) => setPlayhead(timeAt(ev.clientX));
    to(e);
    const move = (ev: PointerEvent) => to(ev);
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Fit the whole project into the viewport.
  const fitAll = () => {
    const vw = scrollRef.current?.clientWidth ?? 800;
    const usable = Math.max(120, vw - HEADER_W - 24);
    setZoom(usable / Math.max(2, total || 10));
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  };

  // Zoom a clip into focus — frames it to ~CLIP_ZOOM_FRAC of the viewport (with
  // context around it) and centers it. Used by double-click and the toolbar's
  // "zoom to selection" button.
  const zoomToClip = (c: Clip) => {
    const vw = scrollRef.current?.clientWidth ?? 800;
    const usable = Math.max(120, vw - HEADER_W - 40);
    const dur = Math.max(0.5, clipPlayDur(c));
    const target = Math.min(400, Math.max(4, (usable / dur) * CLIP_ZOOM_FRAC));
    setZoom(target);
    requestAnimationFrame(() => {
      // Center the clip in the lane viewport.
      const mid = (c.start + dur / 2) * target;
      if (scrollRef.current) scrollRef.current.scrollLeft = Math.max(0, mid - usable / 2);
    });
  };

  // Selected clip (if any) — drives the toolbar's zoom-to-selection button.
  const selClip = "clipId" in selection ? findClip(doc, selection.trackId, selection.clipId) : undefined;

  // #4 Marquee: a plain drag on empty lane space draws a selection box and
  // selects every clip it touches (across tracks); a click (no drag) just moves
  // the playhead there.
  const lanePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) > 4) moved = true;
      if (moved) setMarquee({ x0: startX, y0: startY, x1: ev.clientX, y1: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setMarquee(null);
      if (!moved) {
        onSelect({ kind: "none" });
        setPlayhead(timeAt(ev.clientX));
        return;
      }
      const box = {
        left: Math.min(startX, ev.clientX),
        right: Math.max(startX, ev.clientX),
        top: Math.min(startY, ev.clientY),
        bottom: Math.max(startY, ev.clientY),
      };
      const picks: { trackId: string; clipId: string }[] = [];
      document.querySelectorAll<HTMLElement>("[data-clip]").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.right >= box.left && r.left <= box.right && r.bottom >= box.top && r.top <= box.bottom) {
          const [trackId, clipId] = (el.dataset.clip || "").split("|");
          if (trackId && clipId) picks.push({ trackId, clipId });
        }
      });
      const last = picks[picks.length - 1];
      // Set the single (Inspector) selection FIRST — it routes through
      // StudioView.select → store.select, which resets selClips to one clip.
      // Then apply the full multi-selection so it wins.
      onSelect(last ? { kind: "clip", trackId: last.trackId, clipId: last.clipId } : { kind: "none" });
      useStudio.getState().selectClips(picks);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const openMenu = (m: ClipMenu) => setMenu(m);

  return (
    <div className="flex h-[46%] min-h-0 shrink-0 flex-col border-t hairline bg-panel/40">
      <TimelineToolbar
        doc={doc}
        px={px}
        setZoom={setZoom}
        snap={snap}
        onToggleSnap={() => setSnap((v) => !v)}
        ripple={ripple}
        onToggleRipple={() => setRipple((v) => !v)}
        onSplit={splitAtPlayhead}
        onDelete={() => (ripple ? useStudio.getState().rippleDelete() : deleteSelected())}
        onMarker={addMarker}
        onFit={fitAll}
        onZoomSel={selClip ? () => zoomToClip(selClip) : undefined}
        onAddTrack={addTrack}
        playhead={playhead}
      />

      <div ref={scrollRef} data-tl-scroll className="scrollbar-thin relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: HEADER_W + contentW }}>
          {/* Ruler */}
          <div className="sticky top-0 z-20 flex h-[26px] bg-panel">
            <div className="sticky left-0 z-40 flex h-full shrink-0 items-center gap-1 border-b border-r hairline bg-panel px-2" style={{ width: HEADER_W }}>
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Timeline</span>
            </div>
            <div
              ref={rulerStripRef}
              onPointerDown={scrub}
              className="relative h-full flex-1 cursor-ew-resize border-b hairline"
              style={{ width: contentW }}
            >
              <RulerTicks px={px} contentDur={contentDur} />
              {(doc.markers || []).map((m) => (
                <div
                  key={m.id}
                  title={m.label || "marker"}
                  className="absolute top-0 bottom-0 z-10 w-px"
                  style={{ left: m.t * px, background: m.color || "#f4b740" }}
                >
                  <span className="absolute -top-0 left-0 h-2 w-2 -translate-x-1/2 rotate-45" style={{ background: m.color || "#f4b740" }} />
                </div>
              ))}
            </div>
          </div>

          {/* Track rows */}
          {rows.map((track) => (
            <TrackRow
              key={track.id}
              doc={doc}
              track={track}
              px={px}
              contentW={contentW}
              selection={selection}
              onSelect={onSelect}
              onDblClip={zoomToClip}
              timeAt={timeAt}
              snapEnabled={snap}
              snapCandidates={snapCandidates}
              laneEls={laneEls}
              rows={rows}
              onLanePointerDown={lanePointerDown}
              onOpenMenu={openMenu}
              ripple={ripple}
              collapsed={!!prefs.collapsed[track.id]}
              locked={!!prefs.locked[track.id]}
              onToggleCollapse={() => toggleCollapse(track.id)}
              onToggleLock={() => toggleLock(track.id)}
            />
          ))}

          {/* Playhead spanning every lane */}
          <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-brand" style={{ left: HEADER_W + playhead * px }}>
            <span className="absolute -top-0 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 bg-brand shadow-[0_0_8px_var(--brand)]" />
          </div>

          {/* Snap guide */}
          {snap && snapLine != null && (
            <div className="pointer-events-none absolute top-0 bottom-0 z-30 w-px bg-signal/80" style={{ left: HEADER_W + snapLine * px }} />
          )}
        </div>
      </div>

      {/* #4 Marquee box (fixed / screen coords) */}
      {marquee && (
        <div
          className="pointer-events-none fixed z-50 rounded-sm border border-brand bg-brand/15"
          style={{
            left: Math.min(marquee.x0, marquee.x1),
            top: Math.min(marquee.y0, marquee.y1),
            width: Math.abs(marquee.x1 - marquee.x0),
            height: Math.abs(marquee.y1 - marquee.y0),
          }}
        />
      )}

      {/* #2 Clip context menu */}
      {menu && <ClipContextMenu menu={menu} onClose={() => setMenu(null)} timeAt={timeAt} zoomToClip={zoomToClip} onSelect={onSelect} />}
    </div>
  );
}

// ─────────────────────────── context menu (#2) ────────────────────────────

type ClipMenu = { x: number; y: number; trackId: string; clipId: string; isTitle: boolean; hasAudio: boolean; detached: boolean; disabled: boolean; speed: number };

function ClipContextMenu({
  menu,
  onClose,
  timeAt,
  zoomToClip,
  onSelect,
}: {
  menu: ClipMenu;
  onClose: () => void;
  timeAt: (clientX: number) => number;
  zoomToClip: (c: Clip) => void;
  onSelect: (s: Selection) => void;
}) {
  const { trackId, clipId, isTitle, hasAudio, detached, disabled, speed } = menu;
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  const st = () => useStudio.getState();
  const clip = () => findClip(st().doc, trackId, clipId);
  const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

  const items: ({ label: string; icon: React.ComponentType<{ className?: string }>; onClick: () => void; danger?: boolean } | "sep" | "speedrow")[] = [
    {
      label: "Split here",
      icon: Scissors,
      onClick: () => {
        st().setPlayhead(timeAt(menu.x));
        st().select(trackId, clipId);
        st().splitAtPlayhead();
      },
    },
    { label: "Duplicate", icon: Copy, onClick: () => st().duplicateClip(trackId, clipId) },
    "sep",
    ...(!isTitle && hasAudio && !detached
      ? [{ label: "Detach audio", icon: Link2, onClick: () => st().detachAudio(trackId, clipId) }]
      : []),
    ...(detached ? [{ label: "Re-attach audio", icon: Link2, onClick: () => st().attachAudio(trackId, clipId) }] : []),
    { label: "Reset transform", icon: RotateCcw, onClick: () => st().updateClip(trackId, clipId, { transform: { x: 0, y: 0, scale: 1, opacity: 1, rotation: 0 } }) },
    ...(isTitle ? [] : (["speedrow"] as const)),
    { label: disabled ? "Enable clip" : "Disable clip", icon: disabled ? Eye : Ban, onClick: () => st().updateClip(trackId, clipId, { disabled: !disabled }) },
    {
      label: "Zoom to clip",
      icon: Focus,
      onClick: () => {
        const c = clip();
        if (c) zoomToClip(c);
      },
    },
    "sep",
    {
      label: "Delete",
      icon: Trash2,
      danger: true,
      onClick: () => {
        st().select(trackId, clipId);
        st().deleteSelected();
      },
    },
    {
      label: "Ripple delete (close gap)",
      icon: Trash2,
      danger: true,
      onClick: () => {
        st().select(trackId, clipId);
        st().rippleDelete();
      },
    },
  ];

  // Close on any outside interaction.
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  // Keep the menu on-screen.
  const left = Math.min(menu.x, window.innerWidth - 200);
  const top = Math.min(menu.y, window.innerHeight - items.length * 30 - 12);

  return (
    <div
      className="fixed z-[60] w-52 rounded-lg border hairline bg-panel p-1 shadow-xl"
      style={{ left, top }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it, i) =>
        it === "sep" ? (
          <div key={i} className="my-1 border-t hairline" />
        ) : it === "speedrow" ? (
          <div key={i} className="flex items-center gap-1 px-2 py-1.5">
            <Gauge className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="mr-1 text-[12.5px]">Speed</span>
            <div className="ml-auto flex items-center gap-0.5">
              {SPEEDS.map((sp) => (
                <button
                  key={sp}
                  onClick={run(() => st().updateClip(trackId, clipId, { speed: sp === 1 ? undefined : sp }))}
                  className={cn(
                    "rounded px-1 py-0.5 text-[10.5px] tabular hover:bg-panel-2",
                    Math.abs((speed || 1) - sp) < 1e-6 ? "bg-brand-soft text-brand" : "text-muted-foreground"
                  )}
                >
                  {sp}×
                </button>
              ))}
            </div>
          </div>
        ) : (
          <button
            key={i}
            onClick={run(() => {
              onSelect(isTitle ? { kind: "overlay", trackId, clipId } : { kind: "clip", trackId, clipId });
              it.onClick();
            })}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[12.5px] hover:bg-panel-2",
              it.danger ? "text-destructive" : "text-foreground"
            )}
          >
            <it.icon className={cn("h-3.5 w-3.5", it.danger ? "text-destructive" : "text-muted-foreground")} />
            {it.label}
          </button>
        )
      )}
    </div>
  );
}

// ─────────────────────────────── toolbar ──────────────────────────────────

function TimelineToolbar({
  doc,
  px,
  setZoom,
  snap,
  onToggleSnap,
  ripple,
  onToggleRipple,
  onSplit,
  onDelete,
  onMarker,
  onFit,
  onZoomSel,
  onAddTrack,
  playhead,
}: {
  doc: EditDoc;
  px: number;
  setZoom: (px: number) => void;
  snap: boolean;
  onToggleSnap: () => void;
  ripple: boolean;
  onToggleRipple: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onMarker: () => void;
  onFit: () => void;
  onZoomSel?: () => void;
  onAddTrack: (kind: "video" | "overlay" | "audio") => void;
  playhead: number;
}) {
  const clipCount = doc.tracks.reduce((n, t) => n + (t.clips?.length ?? 0), 0);
  const trackCount = doc.tracks.filter((t) => t.kind !== "background" && t.kind !== "caption").length;

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b hairline px-3">
      <div className="flex items-center gap-1.5">
        <ToolBtn title="Split at playhead (S)" onClick={onSplit}>
          <Scissors className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title="Delete selection (⌫)" onClick={onDelete}>
          <Trash2 className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title="Add marker at playhead" onClick={onMarker}>
          <MapPin className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title={snap ? "Snapping on" : "Snapping off"} onClick={onToggleSnap} active={snap}>
          <Magnet className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title={ripple ? "Ripple edit on — trims/deletes close the gap" : "Ripple edit off"} onClick={onToggleRipple} active={ripple}>
          <ArrowLeftRight className="h-4 w-4" />
        </ToolBtn>
      </div>

      <span className="ml-1 rounded bg-panel-2 px-1.5 py-0.5 text-[10px] tabular text-muted-foreground">
        {trackCount} tracks · {clipCount} clips
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <div className="mr-1 flex items-center gap-0.5 rounded-md border hairline bg-panel-2 p-0.5">
          <button onClick={() => onAddTrack("video")} title="Add video track" className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-panel-3 hover:text-foreground">+ Video</button>
          <button onClick={() => onAddTrack("overlay")} title="Add overlay track" className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-panel-3 hover:text-foreground">+ Overlay</button>
          <button onClick={() => onAddTrack("audio")} title="Add audio track" className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-panel-3 hover:text-foreground">+ Audio</button>
        </div>

        <span className="tabular rounded-md border hairline bg-panel-2 px-2 py-1 text-[11px] text-muted-foreground">{fmtTC(playhead)}</span>

        <ToolBtn title="Zoom to selected clip" onClick={onZoomSel} disabled={!onZoomSel}>
          <Focus className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title="Zoom out" onClick={() => setZoom(px / 1.4)}>
          <ZoomOut className="h-4 w-4" />
        </ToolBtn>
        <input
          type="range"
          min={4}
          max={400}
          step={1}
          value={px}
          onChange={(e) => setZoom(+e.target.value)}
          title="Zoom"
          className="h-1 w-24 cursor-pointer accent-[var(--brand)]"
        />
        <button
          title="Reset zoom to default"
          onClick={() => setZoom(80)}
          className="w-11 shrink-0 rounded-md border hairline bg-panel-2 py-1 text-center text-[10.5px] tabular text-muted-foreground hover:text-foreground"
        >
          {Math.round((px / 80) * 100)}%
        </button>
        <ToolBtn title="Zoom in" onClick={() => setZoom(px * 1.4)}>
          <ZoomIn className="h-4 w-4" />
        </ToolBtn>
        <ToolBtn title="Fit project to view" onClick={onFit}>
          <Maximize2 className="h-4 w-4" />
        </ToolBtn>
      </div>
    </div>
  );
}

function ToolBtn({ children, title, active, disabled, onClick }: { children: React.ReactNode; title?: string; active?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <button
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-panel-2 hover:text-foreground",
        active && "bg-brand-soft text-brand",
        disabled && "opacity-40 hover:bg-transparent hover:text-muted-foreground"
      )}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────── ruler ────────────────────────────────────

function RulerTicks({ px, contentDur }: { px: number; contentDur: number }) {
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find((s) => s * px >= 64) ?? 600;
  const ticks: number[] = [];
  for (let t = 0; t <= contentDur; t += step) ticks.push(+t.toFixed(3));
  return (
    <>
      {ticks.map((t) => (
        <div key={t} className="absolute top-0 bottom-0" style={{ left: t * px }}>
          <span className="absolute bottom-0 left-0 h-2 w-px bg-hairline" />
          <span className="absolute top-0.5 left-1 text-[9px] tabular text-muted-foreground">{fmtTC(t)}</span>
        </div>
      ))}
    </>
  );
}

// ─────────────────────────────── track row ────────────────────────────────

function TrackRow({
  doc,
  track,
  px,
  contentW,
  selection,
  onSelect,
  onDblClip,
  timeAt,
  snapEnabled,
  snapCandidates,
  laneEls,
  rows,
  onLanePointerDown,
  onOpenMenu,
  ripple,
  collapsed,
  locked,
  onToggleCollapse,
  onToggleLock,
}: {
  doc: EditDoc;
  track: Track;
  px: number;
  contentW: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onDblClip: (c: Clip) => void;
  timeAt: (clientX: number) => number;
  snapEnabled: boolean;
  snapCandidates: (excludeClipId?: string) => number[];
  laneEls: React.MutableRefObject<Map<string, HTMLDivElement>>;
  rows: Track[];
  onLanePointerDown: (e: React.PointerEvent) => void;
  onOpenMenu: (m: ClipMenu) => void;
  ripple: boolean;
  collapsed: boolean;
  locked: boolean;
  onToggleCollapse: () => void;
  onToggleLock: () => void;
}) {
  const rowH = collapsed ? 20 : ROW_H[track.kind] ?? 48;
  const isCaption = track.kind === "caption";
  const setSnapLine = useStudio((s) => s.setSnapLine);

  // #6 Cross-dissolve at a cut: adjacent clip pairs (next.start ≈ cur end) get a
  // clickable badge on the boundary that toggles a dissolve transition on both.
  const sorted = [...(track.clips || [])].sort((a, b) => a.start - b.start);
  const cuts: { at: number; a: Clip; b: Clip }[] = [];
  if (!isCaption)
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i]!;
      const b = sorted[i + 1]!;
      if (Math.abs(clipEnd(a) - b.start) < 0.06) cuts.push({ at: b.start, a, b });
    }
  const toggleDissolve = (a: Clip, b: Clip) => {
    const st = useStudio.getState();
    const on = !!a.transitionOut || !!b.transitionIn;
    st.beginTransient();
    st.updateClip(track.id, a.id, { transitionOut: on ? undefined : { type: "dissolve", duration: 0.5 } });
    st.updateClip(track.id, b.id, { transitionIn: on ? undefined : { type: "dissolve", duration: 0.5 } });
    st.commitTransient();
  };

  // Media drops from the left Media panel (kind-scoped types, see MediaCard).
  const accepts = track.kind === "audio" ? ["audio"] : track.kind === "video" ? ["video", "image"] : track.kind === "overlay" ? ["image", "video"] : [];
  const [dropOk, setDropOk] = useState(false);
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
    if (!assetId) return;
    const at = timeAt(e.clientX);
    useStudio.getState().addClip(track.id, assetId, +at.toFixed(3));
  };

  // Empty-lane pointerdown → marquee/click handled by the root (box-select or
  // move the playhead). Only when the press starts on the lane background, not a
  // clip.
  const onLaneDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget) return;
    onLanePointerDown(e);
  };

  return (
    <div className={cn("flex border-b hairline", (track.hidden || track.muted) && "opacity-60")} style={{ height: rowH }}>
      <TrackHeader doc={doc} track={track} collapsed={collapsed} locked={locked} onToggleCollapse={onToggleCollapse} onToggleLock={onToggleLock} />
      <div
        ref={(el) => {
          if (el) laneEls.current.set(track.id, el);
          else laneEls.current.delete(track.id);
        }}
        onPointerDown={locked ? undefined : onLaneDown}
        onDragOver={!locked && accepts.length ? onLaneDragOver : undefined}
        onDrop={!locked && accepts.length ? onLaneDrop : undefined}
        onDragLeave={() => dropOk && setDropOk(false)}
        className={cn(
          "relative flex-1",
          track.kind === "video" && "bg-panel/20",
          track.kind === "overlay" && "bg-panel/10",
          track.kind === "audio" && "bg-panel-2/20",
          isCaption && "bg-panel-2/10",
          locked && "bg-[repeating-linear-gradient(45deg,transparent_0_6px,rgba(255,255,255,0.02)_6px_8px)]",
          dropOk && "ring-1 ring-inset ring-brand"
        )}
        style={{ width: contentW }}
      >
        {isCaption
          ? (track.cues || []).map((cue) => (
              <CueBlock key={cue.id} cue={cue} px={px} rowH={rowH} selection={selection} onSelect={onSelect} timeAt={timeAt} snapEnabled={snapEnabled} snapCandidates={snapCandidates} setSnapLine={setSnapLine} />
            ))
          : (track.clips || []).map((clip) => (
              <ClipBar
                key={clip.id}
                doc={doc}
                track={track}
                clip={clip}
                px={px}
                rowH={rowH}
                collapsed={collapsed}
                locked={locked}
                ripple={ripple}
                selection={selection}
                onSelect={onSelect}
                onDblClip={onDblClip}
                timeAt={timeAt}
                snapEnabled={snapEnabled}
                snapCandidates={snapCandidates}
                setSnapLine={setSnapLine}
                laneEls={laneEls}
                rows={rows}
                onOpenMenu={onOpenMenu}
              />
            ))}

        {/* #6 cross-dissolve cut badges */}
        {!collapsed &&
          !locked &&
          cuts.map(({ at, a, b }) => {
            const on = !!a.transitionOut || !!b.transitionIn;
            return (
              <button
                key={a.id + b.id}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  toggleDissolve(a, b);
                }}
                title={on ? "Remove cross-dissolve" : "Add cross-dissolve (0.5s)"}
                className={cn(
                  // Pinned to the top of the lane so it doesn't cover the clip
                  // edge trim handles (which run the full height at the same x).
                  "absolute top-0.5 z-30 grid h-3.5 w-3.5 -translate-x-1/2 place-items-center rounded-full border transition-colors",
                  on ? "border-brand bg-brand text-white" : "border-white/40 bg-panel/80 text-muted-foreground opacity-60 hover:opacity-100 hover:text-foreground"
                )}
                style={{ left: at * px }}
              >
                <Blend className="h-2.5 w-2.5" />
              </button>
            );
          })}
      </div>
    </div>
  );
}

function TrackHeader({
  doc,
  track,
  collapsed,
  locked,
  onToggleCollapse,
  onToggleLock,
}: {
  doc: EditDoc;
  track: Track;
  collapsed: boolean;
  locked: boolean;
  onToggleCollapse: () => void;
  onToggleLock: () => void;
}) {
  const toggleTrackFlag = useStudio((s) => s.toggleTrackFlag);
  const moveTrackZ = useStudio((s) => s.moveTrackZ);
  const removeTrack = useStudio((s) => s.removeTrack);
  const meta = kindMeta[track.kind] ?? kindMeta.video;
  const isAudio = track.kind === "audio";
  const isCaption = track.kind === "caption";
  const siblings = doc.tracks.filter((t) => t.kind === track.kind).length;

  const ctl = (title: string, active: boolean, onClick: () => void, child: React.ReactNode) => (
    <button
      title={title}
      onClick={onClick}
      className={cn("grid h-5 w-5 place-items-center rounded hover:bg-panel-3", active ? "text-brand" : "text-muted-foreground hover:text-foreground")}
    >
      {child}
    </button>
  );

  // #8 collapsed → single compact row (expand chevron + name + lock).
  if (collapsed) {
    return (
      <div className="sticky left-0 z-40 flex shrink-0 items-center gap-1 border-r hairline bg-panel px-2" style={{ width: HEADER_W }}>
        {ctl("Expand track", false, onToggleCollapse, <ChevronRightIcon />)}
        <meta.Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-[10.5px] font-medium">{track.name || meta.label}</span>
        {ctl(locked ? "Unlock" : "Lock", locked, onToggleLock, locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />)}
      </div>
    );
  }

  return (
    <div className="sticky left-0 z-40 flex shrink-0 flex-col justify-center gap-1 border-r hairline bg-panel px-2 py-1" style={{ width: HEADER_W }}>
      <div className="flex items-center gap-1">
        {ctl("Collapse track", false, onToggleCollapse, <ChevronDown className="h-3 w-3" />)}
        <meta.Icon className="h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="truncate text-[11px] font-medium">{track.name || meta.label}</span>
      </div>
      {!isCaption && (
        <div className="flex items-center gap-0.5">
          {!isAudio && siblings > 1 && (
            <>
              {ctl("Bring forward", false, () => moveTrackZ(track.id, +1), <ChevronUp className="h-3 w-3" />)}
              {ctl("Send backward", false, () => moveTrackZ(track.id, -1), <ChevronDown className="h-3 w-3" />)}
            </>
          )}
          {!isAudio && ctl(track.hidden ? "Show" : "Hide", !!track.hidden, () => toggleTrackFlag(track.id, "hidden"), track.hidden ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />)}
          {ctl(track.muted ? "Unmute" : "Mute", !!track.muted, () => toggleTrackFlag(track.id, "muted"), track.muted ? <VolumeX className="h-3 w-3" /> : <Volume2 className="h-3 w-3" />)}
          {ctl(track.solo ? "Unsolo" : "Solo", !!track.solo, () => toggleTrackFlag(track.id, "solo"), <span className="text-[9px] font-bold leading-none">S</span>)}
          {ctl(locked ? "Unlock track" : "Lock track", locked, onToggleLock, locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />)}
          {ctl("Remove track", false, () => {
            const n = track.clips?.length ?? 0;
            if (n === 0 || confirm(`Remove "${track.name || track.kind}" and its ${n} clip${n === 1 ? "" : "s"}?`)) removeTrack(track.id);
          }, <Trash2 className="h-3 w-3" />)}
        </div>
      )}
      {isCaption && (
        <div className="flex items-center gap-0.5">
          {ctl(locked ? "Unlock track" : "Lock track", locked, onToggleLock, locked ? <Lock className="h-3 w-3" /> : <Unlock className="h-3 w-3" />)}
          <span className="ml-1 text-[10px] text-muted-foreground">{track.cues?.length ?? 0} cues</span>
        </div>
      )}
    </div>
  );
}

// small right-chevron used by the collapsed header
function ChevronRightIcon() {
  return <ChevronDown className="h-3 w-3 -rotate-90" />;
}

// ─────────────────────────────── clip bar ─────────────────────────────────

type Gesture = "move" | "in" | "out";

function ClipBar({
  doc,
  track,
  clip,
  px,
  rowH,
  collapsed,
  locked,
  ripple,
  selection,
  onSelect,
  onDblClip,
  timeAt,
  snapEnabled,
  snapCandidates,
  setSnapLine,
  laneEls,
  rows,
  onOpenMenu,
}: {
  doc: EditDoc;
  track: Track;
  clip: Clip;
  px: number;
  rowH: number;
  collapsed: boolean;
  locked: boolean;
  ripple: boolean;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onDblClip: (c: Clip) => void;
  timeAt: (clientX: number) => number;
  snapEnabled: boolean;
  snapCandidates: (excludeClipId?: string) => number[];
  setSnapLine: (t: number | null) => void;
  laneEls: React.MutableRefObject<Map<string, HTMLDivElement>>;
  rows: Track[];
  onOpenMenu: (m: ClipMenu) => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const asset = doc.assets.find((a) => a.id === clip.assetId);
  const isTitle = !!clip.title;
  const hue = hueFor(clip.id);
  const dur = clipPlayDur(clip);
  const srcPlay = clipSrcDur(clip);
  const hold = clip.hold && clip.hold > 0 ? clip.hold : 0;
  const left = clip.start * px;
  const width = Math.max(6, dur * px);
  // Highlight when it's the single selection OR part of a marquee multi-select.
  const inMulti = useStudio((s) => s.selClips.length > 1 && s.selClips.some((c) => c.clipId === clip.id));
  const selected = ("clipId" in selection && selection.clipId === clip.id) || inMulti;

  const label = isTitle ? clip.title!.text || "Title" : asset?.name || "Clip";
  const isAudioLane = track.kind === "audio";
  const showWave = !!asset && !isTitle && (isAudioLane || asset.hasAudio !== false);

  // #3 Level (volume for audio, opacity for visual) and fades — drawn as an
  // envelope and adjustable with on-clip handles.
  const fadeIn = clip.fadeIn && clip.fadeIn > 0 ? clip.fadeIn : 0;
  const fadeOut = clip.fadeOut && clip.fadeOut > 0 ? clip.fadeOut : 0;
  const level = isAudioLane ? (clip.volume ?? 1) : (clip.transform.opacity ?? 1);
  const levelY = (1 - Math.max(0, Math.min(1, level))) * (rowH - 8) + 2; // px from clip top

  // Snap a proposed edge value to the nearest candidate within SNAP_PX.
  const snapValue = (v: number): number => {
    if (!snapEnabled) return v;
    const thresh = SNAP_PX / px;
    let best = v;
    let bestD = thresh;
    for (const c of snapCandidates(clip.id)) {
      const d = Math.abs(v - c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };

  const beginDrag = (mode: Gesture) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useStudio.getState();
    // Group move: if this clip is already part of a marquee multi-selection,
    // keep the group and move them all; otherwise select just this clip.
    const inGroup = mode === "move" && st.selClips.length > 1 && st.selClips.some((c) => c.clipId === clip.id);
    const group = inGroup ? st.selClips.slice() : null;
    const origStarts = new Map<string, { trackId: string; start: number }>();
    if (group)
      for (const g of group) {
        const c = findClip(st.doc, g.trackId, g.clipId);
        if (c) origStarts.set(g.clipId, { trackId: g.trackId, start: c.start });
      }
    if (!group) {
      st.select(track.id, clip.id);
      onSelect(isTitle ? { kind: "overlay", trackId: track.id, clipId: clip.id } : { kind: "clip", trackId: track.id, clipId: clip.id });
    }
    st.beginTransient();

    const startX = e.clientX;
    const origStart = clip.start;
    const origIn = clip.in;
    const origOut = clip.out;
    const origHold = hold;
    const origEnd0 = origStart + dur; // #5 ripple reference
    const retime = mode === "out" && e.altKey; // #10 Alt-drag right edge = retime
    const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const srcDur = asset && asset.duration > 0 ? asset.duration : Infinity;
    let curTrack = track.id;

    const move = (ev: PointerEvent) => {
      const s2 = useStudio.getState();
      const dx = (ev.clientX - startX) / px;

      if (mode === "move" && group) {
        // Move the whole group by the primary clip's snapped delta (no cross-track).
        const ns = snapValue(Math.max(0, origStart + dx));
        setSnapLine(snapEnabled && Math.abs(ns - (origStart + dx)) > 1e-6 ? ns : null);
        const delta = ns - origStart;
        s2.batchUpdateClips(
          group.map((g) => {
            const o = origStarts.get(g.clipId)!;
            return { trackId: o.trackId, clipId: g.clipId, patch: { start: +Math.max(0, o.start + delta).toFixed(3) } };
          })
        );
      } else if (mode === "move") {
        let ns = snapValue(Math.max(0, origStart + dx));
        // Also try snapping the clip's END to a candidate (butt-join).
        if (snapEnabled) {
          const thresh = SNAP_PX / px;
          for (const c of snapCandidates(clip.id)) {
            if (Math.abs(origStart + dx + dur - c) < thresh && Math.abs(origStart + dx + dur - c) < Math.abs(ns - (origStart + dx))) {
              ns = Math.max(0, c - dur);
            }
          }
        }
        setSnapLine(snapEnabled && Math.abs(ns - (origStart + dx)) > 1e-6 ? ns : null);

        // Cross-track: hand the clip to a same-kind lane under the pointer.
        let target = curTrack;
        for (const t of rows) {
          if (t.kind !== track.kind || t.id === curTrack) continue;
          const el = laneEls.current.get(t.id);
          if (!el) continue;
          const r = el.getBoundingClientRect();
          if (ev.clientY >= r.top && ev.clientY <= r.bottom) {
            target = t.id;
            break;
          }
        }
        s2.moveClip(curTrack, target, clip.id, ns);
        curTrack = target;
      } else if (mode === "out") {
        const rawEnd = snapValue(origStart + dur + dx);
        const desiredPlay = Math.max(0.1, rawEnd - origStart);
        setSnapLine(snapEnabled ? rawEnd : null);
        if (retime && !isTitle) {
          // #10 retime: stretch/compress the source span to fill the new length.
          const srcSpan = origOut - origIn;
          const targetSrcPlay = Math.max(0.05, desiredPlay - origHold);
          const newSpeed = Math.max(0.1, Math.min(10, srcSpan / targetSrcPlay));
          s2.updateClip(curTrack, clip.id, { speed: +newSpeed.toFixed(3) });
        } else if (isTitle) {
          s2.updateClip(curTrack, clip.id, { out: +desiredPlay.toFixed(3) });
        } else {
          const maxSrcPlay = (srcDur - origIn) / sp; // seconds of real footage left
          const play = Math.min(desiredPlay, maxSrcPlay);
          const newOut = +(origIn + play * sp).toFixed(3);
          const newHold = +Math.max(0, desiredPlay - play).toFixed(3);
          s2.updateClip(curTrack, clip.id, { out: Math.max(origIn + 0.1, newOut), hold: newHold > 0.001 ? newHold : undefined });
        }
      } else {
        // trim-in: move the head; keep the tail fixed in time.
        const rawStart = snapValue(Math.max(0, origStart + dx));
        setSnapLine(snapEnabled ? rawStart : null);
        if (isTitle) {
          const end = origStart + origOut; // in=0 for titles
          const ns = Math.min(rawStart, end - 0.1);
          s2.updateClip(curTrack, clip.id, { start: +ns.toFixed(3), out: +(end - ns).toFixed(3) });
        } else {
          const delta = rawStart - origStart;
          const newIn = Math.min(Math.max(0, origIn + delta * sp), origOut - 0.1);
          const applied = (newIn - origIn) / sp;
          s2.updateClip(curTrack, clip.id, { in: +newIn.toFixed(3), start: +(origStart + applied).toFixed(3) });
        }
      }
    };
    const up = () => {
      const s3 = useStudio.getState();
      // #5 Ripple: after an end-changing trim (out / retime), shift downstream
      // clips on the same track by the end delta so the gap closes / no overlap.
      if (ripple && !group && mode === "out") {
        const cur = findClip(s3.doc, curTrack, clip.id);
        if (cur) {
          const delta = +(cur.start + clipPlayDur(cur) - origEnd0).toFixed(3);
          if (Math.abs(delta) > 1e-3) {
            const t = s3.doc?.tracks.find((x) => x.id === curTrack);
            const shifts = (t?.clips || [])
              .filter((c) => c.id !== clip.id && c.start >= origEnd0 - 1e-3)
              .map((c) => ({ trackId: curTrack, clipId: c.id, patch: { start: +Math.max(0, c.start + delta).toFixed(3) } }));
            if (shifts.length) s3.batchUpdateClips(shifts);
          }
        }
      }
      s3.commitTransient();
      setSnapLine(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Which gesture a pointerdown starts, based on where in the bar it lands.
  // Only the left button drags — right-click is reserved for the context menu.
  // Locked tracks ignore all clip gestures.
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || locked) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offX = e.clientX - r.left;
    const mode: Gesture = offX < TRIM_PX ? "in" : offX > r.width - TRIM_PX ? "out" : "move";
    beginDrag(mode)(e);
  };

  // #3 Fade handle drag — sets fadeIn / fadeOut from the corner distance.
  const fadeDrag = (which: "in" | "out") => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useStudio.getState();
    st.select(track.id, clip.id);
    st.beginTransient();
    const move = (ev: PointerEvent) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const off = which === "in" ? ev.clientX - r.left : r.right - ev.clientX;
      const sec = Math.max(0, Math.min(dur, off / px));
      st.updateClip(track.id, clip.id, which === "in" ? { fadeIn: +sec.toFixed(2) } : { fadeOut: +sec.toFixed(2) });
    };
    const up = () => {
      st.commitTransient();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // #3 Level rubber-band — volume (audio) or opacity (visual) from vertical drag.
  const levelDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useStudio.getState();
    st.select(track.id, clip.id);
    st.beginTransient();
    const move = (ev: PointerEvent) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const frac = 1 - Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height));
      const v = +frac.toFixed(2);
      const cur = findClip(useStudio.getState().doc, track.id, clip.id);
      if (!cur) return;
      if (isAudioLane) st.updateClip(track.id, clip.id, { volume: v });
      else st.updateClip(track.id, clip.id, { transform: { ...cur.transform, opacity: v } });
    };
    const up = () => {
      st.commitTransient();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onCtx = (e: React.MouseEvent) => {
    if (locked) return;
    e.preventDefault();
    e.stopPropagation();
    const detached = doc.tracks.some((t) => t.clips?.some((c) => c.sourceClip === clip.id));
    onOpenMenu({
      x: e.clientX,
      y: e.clientY,
      trackId: track.id,
      clipId: clip.id,
      isTitle,
      hasAudio: !isTitle && asset?.hasAudio !== false,
      detached,
      disabled: !!clip.disabled,
      speed: clip.speed && clip.speed > 0 ? clip.speed : 1,
    });
  };

  // Envelope/handles: skip on titles (own text opacity), collapsed rows, and
  // locked tracks. Waveform likewise hidden when collapsed.
  const showLevel = !isTitle && !collapsed && !locked;
  const showWaveNow = showWave && !collapsed;
  // #7 keyframe diamonds — only for the selected clip, expanded, unlocked.
  const kfList: { prop: string; index: number; t: number }[] = [];
  if (selected && !collapsed && !locked && clip.keyframes)
    for (const [prop, pts] of Object.entries(clip.keyframes))
      pts.forEach((p, index) => kfList.push({ prop, index, t: p.t }));

  const kfDrag = (prop: string, index: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const st = useStudio.getState();
    st.beginTransient();
    const move = (ev: PointerEvent) => {
      const r = rootRef.current?.getBoundingClientRect();
      if (!r) return;
      const tLocal = Math.max(0, Math.min(dur, (ev.clientX - r.left) / px));
      st.moveKeyframe(track.id, clip.id, prop, index, tLocal);
    };
    const up = () => {
      st.commitTransient();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const H = rowH - 8; // clip inner height (top-1 + bottom-1)
  return (
    <div
      ref={rootRef}
      data-clip={`${track.id}|${clip.id}`}
      onPointerDown={onDown}
      onContextMenu={onCtx}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDblClip(clip);
      }}
      title={`${label} · ${dur.toFixed(1)}s${clip.speed && clip.speed !== 1 ? ` · ${clip.speed}×` : ""}${hold > 0 ? ` (incl. ${hold.toFixed(1)}s freeze)` : ""}${clip.disabled ? " · disabled" : ""}`}
      className={cn(
        "group absolute top-1 bottom-1 select-none overflow-hidden rounded-md border",
        locked ? "cursor-default" : "cursor-grab active:cursor-grabbing",
        selected ? "border-brand shadow-[0_0_0_1px_var(--brand)]" : "border-black/30 hover:border-white/30",
        clip.disabled && "opacity-40 grayscale"
      )}
      style={{
        left,
        width,
        background: isAudioLane
          ? `linear-gradient(180deg, hsl(${hue} 45% 26%), hsl(${hue} 45% 18%))`
          : `linear-gradient(180deg, hsl(${hue} 55% 30%), hsl(${hue} 50% 18%))`,
      }}
    >
      {/* thumbnail strip for visual clips */}
      {!isAudioLane && asset?.thumbnail && (
        <img src={mediaUrl(asset.thumbnail, asset.createdAt)} alt="" className="absolute inset-0 h-full w-full object-cover opacity-30" />
      )}
      {isTitle && <Type className="absolute right-1 top-1 h-3 w-3 text-white/60" />}

      {/* waveform */}
      {showWaveNow && asset && (
        <ClipWave
          projId={doc.id}
          assetId={asset.id}
          inSec={clip.in}
          outSec={clip.out}
          srcDur={asset.duration || 1}
          hue={hue}
          w={Math.round(width)}
          h={rowH - 8}
        />
      )}

      {/* freeze-frame region marker */}
      {hold > 0 && srcPlay > 0 && (
        <div
          className="absolute inset-y-0 flex items-center justify-center overflow-hidden border-l border-white/20"
          style={{ left: srcPlay * px, width: hold * px, background: "repeating-linear-gradient(45deg, rgba(255,255,255,.12) 0 5px, transparent 5px 10px)" }}
        >
          <span className="text-[7px] font-semibold uppercase tracking-wide text-white/70">❄</span>
        </div>
      )}

      {/* #3 fade + level envelope */}
      {showLevel && (
        <>
          <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${Math.max(1, width)} ${H}`} preserveAspectRatio="none">
            <polyline
              points={`0,${H} ${fadeIn * px},${levelY} ${Math.max(fadeIn * px, width - fadeOut * px)},${levelY} ${width},${H}`}
              fill="none"
              stroke="rgba(255,255,255,0.5)"
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          </svg>
          <span
            onPointerDown={fadeDrag("in")}
            title={`Fade in${fadeIn ? ` · ${fadeIn.toFixed(1)}s` : ""}`}
            className="absolute z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white/80 bg-panel opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: Math.max(4, fadeIn * px), top: 5 }}
          />
          <span
            onPointerDown={fadeDrag("out")}
            title={`Fade out${fadeOut ? ` · ${fadeOut.toFixed(1)}s` : ""}`}
            className="absolute z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 cursor-ew-resize rounded-full border border-white/80 bg-panel opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: Math.min(width - 4, width - fadeOut * px), top: 5 }}
          />
          <span
            onPointerDown={levelDrag}
            title={`${isAudioLane ? "Volume" : "Opacity"} · ${Math.round(level * 100)}%`}
            className="absolute z-20 h-2 w-6 -translate-x-1/2 -translate-y-1/2 cursor-ns-resize rounded-full border border-white/80 bg-panel/90 opacity-0 transition-opacity group-hover:opacity-100"
            style={{ left: Math.min(Math.max(12, width / 2), Math.max(12, width - 12)), top: levelY }}
          />
        </>
      )}

      {/* #6 transition wedges (dissolve) at the clip edges that carry one */}
      {clip.transitionIn && !collapsed && (
        <div
          className="pointer-events-none absolute inset-y-0 left-0 border-r border-white/30"
          style={{ width: (clip.transitionIn.duration || 0.5) * px, background: "linear-gradient(90deg, rgba(0,0,0,0.55), transparent)" }}
        />
      )}
      {clip.transitionOut && !collapsed && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 border-l border-white/30"
          style={{ width: (clip.transitionOut.duration || 0.5) * px, background: "linear-gradient(270deg, rgba(0,0,0,0.55), transparent)" }}
        />
      )}

      {/* #7 keyframe diamonds (draggable to retime) */}
      {kfList.map(({ prop, index, t }) => (
        <span
          key={`${prop}-${index}`}
          onPointerDown={kfDrag(prop, index)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            useStudio.getState().removeKeyframe(track.id, clip.id, prop, index);
          }}
          title={`${prop} keyframe @ ${t.toFixed(2)}s — drag to retime, double-click to remove`}
          className="absolute bottom-0.5 z-20 h-2 w-2 -translate-x-1/2 rotate-45 cursor-ew-resize border border-black/50 bg-amber-300"
          style={{ left: Math.max(2, Math.min(width - 2, t * px)) }}
        />
      ))}

      {/* label */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center gap-1 px-1.5 pt-0.5">
        <span className={cn("truncate font-medium text-white/90 drop-shadow", collapsed ? "text-[9px]" : "text-[10.5px]")}>{label}</span>
      </div>
      {clip.disabled && <Ban className="pointer-events-none absolute right-1 top-1 h-3 w-3 text-white/80" />}
      {clip.mute && !isAudioLane && !clip.disabled && <VolumeX className="pointer-events-none absolute bottom-1 right-1 h-3 w-3 text-white/60" />}

      {/* trim handles (hidden on locked tracks) */}
      {!locked && (
        <>
          <span className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/20" />
          <span className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-white/0 transition-colors group-hover:bg-white/20" />
        </>
      )}
    </div>
  );
}

// ─────────────────────────────── cue block ────────────────────────────────

function CueBlock({
  cue,
  px,
  rowH,
  selection,
  onSelect,
  timeAt,
  snapEnabled,
  snapCandidates,
  setSnapLine,
}: {
  cue: { id: string; start: number; end: number; text: string };
  px: number;
  rowH: number;
  selection: Selection;
  onSelect: (s: Selection) => void;
  timeAt: (clientX: number) => number;
  snapEnabled: boolean;
  snapCandidates: (excludeClipId?: string) => number[];
  setSnapLine: (t: number | null) => void;
}) {
  const selected = selection.kind === "cue" && selection.cueId === cue.id;
  const left = cue.start * px;
  const width = Math.max(8, (cue.end - cue.start) * px);

  const snapValue = (v: number): number => {
    if (!snapEnabled) return v;
    const thresh = SNAP_PX / px;
    let best = v;
    let bestD = thresh;
    for (const c of snapCandidates()) {
      const d = Math.abs(v - c);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };

  const beginDrag = (mode: Gesture) => (e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    onSelect({ kind: "cue", cueId: cue.id });
    const st = useStudio.getState();
    st.beginTransient();
    const startX = e.clientX;
    const s0 = cue.start;
    const e0 = cue.end;
    const len = e0 - s0;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) / px;
      const g = useStudio.getState();
      if (mode === "move") {
        const ns = snapValue(Math.max(0, s0 + dx));
        setSnapLine(snapEnabled ? ns : null);
        g.updateCue(cue.id, { start: +ns.toFixed(3), end: +(ns + len).toFixed(3) });
      } else if (mode === "in") {
        const ns = Math.min(snapValue(Math.max(0, s0 + dx)), e0 - 0.1);
        setSnapLine(snapEnabled ? ns : null);
        g.updateCue(cue.id, { start: +ns.toFixed(3) });
      } else {
        const ne = Math.max(snapValue(e0 + dx), s0 + 0.1);
        setSnapLine(snapEnabled ? ne : null);
        g.updateCue(cue.id, { end: +ne.toFixed(3) });
      }
    };
    const up = () => {
      useStudio.getState().commitTransient();
      setSnapLine(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const onDown = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const offX = e.clientX - r.left;
    const mode: Gesture = offX < TRIM_PX ? "in" : offX > r.width - TRIM_PX ? "out" : "move";
    beginDrag(mode)(e);
  };

  return (
    <div
      onPointerDown={onDown}
      title={cue.text}
      className={cn(
        "group absolute top-1 bottom-1 cursor-grab select-none overflow-hidden rounded border bg-panel-3/80 px-1.5 active:cursor-grabbing",
        selected ? "border-brand shadow-[0_0_0_1px_var(--brand)]" : "border-white/10 hover:border-white/30"
      )}
      style={{ left, width }}
    >
      <span className="pointer-events-none block truncate pt-0.5 text-[10px] text-foreground">{cue.text || "caption"}</span>
      <span className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize group-hover:bg-white/20" />
      <span className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize group-hover:bg-white/20" />
    </div>
  );
}

// ─────────────────────────────── waveform ─────────────────────────────────

function ClipWave({
  projId,
  assetId,
  inSec,
  outSec,
  srcDur,
  hue,
  w,
  h,
}: {
  projId: string;
  assetId: string;
  inSec: number;
  outSec: number;
  srcDur: number;
  hue: number;
  w: number;
  h: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(0);

  useEffect(() => {
    let alive = true;
    getPeaks(projId, assetId).then(() => alive && setReady((n) => n + 1));
    return () => {
      alive = false;
    };
  }, [projId, assetId]);

  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const peaks = peaksNow(projId, assetId);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    if (!peaks || !peaks.length) return;
    const inFrac = Math.max(0, Math.min(1, inSec / srcDur));
    const outFrac = Math.max(inFrac, Math.min(1, outSec / srcDur));
    const bars = Math.max(1, Math.floor(w / 2));
    ctx.fillStyle = `hsl(${hue} 70% 62%)`;
    const mid = h / 2;
    for (let i = 0; i < bars; i++) {
      const frac = inFrac + ((outFrac - inFrac) * i) / bars;
      const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)));
      const v = peaks[idx] ?? 0;
      const bh = Math.max(0.5, v * (h - 2));
      ctx.fillRect(i * 2, mid - bh / 2, 1, bh);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, projId, assetId, inSec, outSec, srcDur, w, h, hue]);

  return <canvas ref={ref} className="pointer-events-none absolute inset-x-0 bottom-0" style={{ width: w, height: h, opacity: 0.75 }} />;
}

// clipEnd (local, avoids importing bridge's for one call)
function clipEnd(c: Clip): number {
  return c.start + clipPlayDur(c);
}
