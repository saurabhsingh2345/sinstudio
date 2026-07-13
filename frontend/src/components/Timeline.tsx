import { useEffect, useRef, useState } from "react";
import { useStudio, projectDuration } from "../state";
import { api } from "../api";
import { mediaUrl, type Clip, type EditDoc, type Track } from "../types";

// Per-asset peak arrays, fetched once and shared across clips/zoom levels.
const peakCache = new Map<string, Promise<number[]>>();
function getPeaks(projId: string, assetId: string): Promise<number[]> {
  const k = `${projId}:${assetId}`;
  if (!peakCache.has(k)) {
    peakCache.set(
      k,
      api.waveform(projId, assetId).then((r) => r.peaks).catch(() => [])
    );
  }
  return peakCache.get(k)!;
}

// Waveform draws an asset's peaks for the clip's trimmed span, normalized so the
// loudest visible peak fills the lane. Redraws on trim/zoom.
function Waveform({
  projId,
  assetId,
  inS,
  outS,
  duration,
  width,
  height,
}: {
  projId: string;
  assetId: string;
  inS: number;
  outS: number;
  duration: number;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    let ok = true;
    getPeaks(projId, assetId).then((p) => ok && setPeaks(p));
    return () => {
      ok = false;
    };
  }, [projId, assetId]);

  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks || !peaks.length) return;
    const W = Math.max(1, Math.floor(width));
    const H = height;
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    const dur = duration > 0 ? duration : outS - inS || 1;
    const i0 = Math.max(0, Math.floor((inS / dur) * peaks.length));
    const i1 = Math.min(peaks.length, Math.ceil((outS / dur) * peaks.length));
    const slice = peaks.slice(i0, i1);
    if (!slice.length) return;
    let mx = 0;
    for (const v of slice) if (v > mx) mx = v;
    if (mx < 1e-3) mx = 1e-3;
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    const mid = H / 2;
    for (let x = 0; x < W; x++) {
      const idx = Math.min(slice.length - 1, Math.floor((x / W) * slice.length));
      const h = (slice[idx] / mx) * (H * 0.88);
      ctx.fillRect(x, mid - h / 2, 1, Math.max(1, h));
    }
  }, [peaks, inS, outS, duration, width, height]);

  return <canvas ref={ref} className="wave" />;
}

const LABEL_W = 138;
const SNAP = 0.1; // seconds grid snap

export function Timeline() {
  const {
    doc,
    pxPerSec,
    setZoom,
    playhead,
    setPlayhead,
    addClip,
    splitAtPlayhead,
    addTrack,
    addTitle,
    addMarker,
    removeMarker,
    updateMarker,
    snapLine,
  } = useStudio();
  const scrollRef = useRef<HTMLDivElement>(null);
  if (!doc) return null;

  const dur = Math.max(projectDuration(doc), 10);
  const contentW = LABEL_W + dur * pxPerSec + 200;

  const secAt = (clientX: number) => {
    const el = scrollRef.current!;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + el.scrollLeft - LABEL_W;
    return Math.max(0, x / pxPerSec);
  };

  const ticks: number[] = [];
  const step = pxPerSec < 40 ? 5 : pxPerSec < 100 ? 2 : 1;
  for (let s = 0; s <= dur + 5; s += step) ticks.push(s);

  return (
    <div className="timeline">
      <div className="tl-toolbar">
        <strong style={{ fontSize: 12 }}>Timeline</strong>
        <span className="small">{dur.toFixed(1)}s</span>
        <button onClick={splitAtPlayhead} title="Split at playhead (S)">
          ✂ Split
        </button>
        <button onClick={addTitle} title="Add a text/title clip at the playhead">
          T Title
        </button>
        <button onClick={addMarker} title="Add a marker at the playhead">
          ◇ Marker
        </button>
        <span className="tl-addtrack">
          <span className="small">+ track:</span>
          <button onClick={() => addTrack("video")} title="Add a video track">Video</button>
          <button onClick={() => addTrack("overlay")} title="Add an overlay track">Overlay</button>
          <button onClick={() => addTrack("audio")} title="Add an audio track">Audio</button>
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={() => {
            const el = scrollRef.current;
            if (!el) return;
            const avail = el.clientWidth - LABEL_W - 24;
            setZoom(avail / Math.max(projectDuration(doc), 5));
          }}
          title="Zoom to fit the whole project"
        >
          ⤢ Fit
        </button>
        <button onClick={() => setZoom(pxPerSec - 20)}>–</button>
        <span className="small">{pxPerSec}px/s</span>
        <button onClick={() => setZoom(pxPerSec + 20)}>+</button>
      </div>

      <div className="tl-scroll" ref={scrollRef}>
        <div className="tl-grid" style={{ width: contentW }}>
          {/* ruler */}
          <div
            className="tl-ruler"
            onPointerDown={(e) =>
              setPlayhead(magneticScalar(secAt(e.clientX), snapPoints(doc, new Set()), pxPerSec).value)
            }
          >
            {ticks.map((s) => (
              <div key={s} className="tl-tick" style={{ left: LABEL_W + s * pxPerSec }}>
                {s}s
              </div>
            ))}
          </div>

          {/* lanes */}
          <div className="tl-lanes">
            {doc.tracks.map((t) => (
              <Lane key={t.id} track={t} pxPerSec={pxPerSec} secAt={secAt} onDropAsset={addClip} />
            ))}
          </div>

          {/* markers */}
          {(doc.markers || []).map((m) => (
            <div key={m.id} className="tl-marker" style={{ left: LABEL_W + m.t * pxPerSec }}>
              <div
                className="flag"
                style={{ background: m.color || "#f4b740" }}
                title={`${m.label || ""} @ ${m.t.toFixed(2)}s — click to seek · double-click to rename · right-click to delete`}
                onClick={(e) => {
                  e.stopPropagation();
                  setPlayhead(m.t);
                }}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  const l = prompt("Marker label", m.label || "");
                  if (l != null) updateMarker(m.id, { label: l });
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  removeMarker(m.id);
                }}
              >
                {m.label}
              </div>
            </div>
          ))}

          {/* snap guide */}
          {snapLine != null && (
            <div className="tl-snapline" style={{ left: LABEL_W + snapLine * pxPerSec, height: "100%" }} />
          )}

          {/* playhead */}
          <div
            className="tl-playhead"
            style={{ left: LABEL_W + playhead * pxPerSec, height: "100%" }}
          />
        </div>
      </div>
    </div>
  );
}

function Lane({
  track,
  pxPerSec,
  secAt,
  onDropAsset,
}: {
  track: Track;
  pxPerSec: number;
  secAt: (x: number) => number;
  onDropAsset: (trackId: string, assetId: string, start: number) => void;
}) {
  const { toggleTrackFlag, moveTrack, removeTrack } = useStudio();
  const reorderable = track.kind === "video" || track.kind === "overlay" || track.kind === "audio";
  const laneClass = ["tl-lane", track.hidden ? "hidden" : "", track.muted ? "muted" : ""]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className={laneClass}
      onDragOver={(e) => {
        if (track.kind !== "caption") e.preventDefault();
      }}
      onDrop={(e) => {
        const assetId = e.dataTransfer.getData("text/assetId");
        if (assetId && track.kind !== "caption") {
          e.preventDefault();
          onDropAsset(track.id, assetId, snap(secAt(e.clientX)));
        }
      }}
    >
      <div className="lane-label" style={{ width: LABEL_W }}>
        <span className="lane-name" title={track.name || track.kind}>
          {track.name || track.kind}
        </span>
        {track.kind !== "background" && (
          <span className="lane-ctl">
            {track.kind !== "caption" && (
              <button
                className={track.muted ? "on" : ""}
                onClick={() => toggleTrackFlag(track.id, "muted")}
                title="Mute this track's audio"
              >
                M
              </button>
            )}
            <button
              className={track.solo ? "on solo" : ""}
              onClick={() => toggleTrackFlag(track.id, "solo")}
              title="Solo (play only soloed tracks)"
            >
              S
            </button>
            <button
              className={track.hidden ? "on" : ""}
              onClick={() => toggleTrackFlag(track.id, "hidden")}
              title="Hide this track from the export"
            >
              H
            </button>
            {track.kind === "audio" && (
              <button
                className={track.duck ? "on duck" : ""}
                onClick={() => toggleTrackFlag(track.id, "duck")}
                title="Duck: auto-lower this music/bed under the voice"
              >
                D
              </button>
            )}
            {reorderable && (
              <>
                <button onClick={() => moveTrack(track.id, -1)} title="Move up">
                  ▲
                </button>
                <button onClick={() => moveTrack(track.id, 1)} title="Move down">
                  ▼
                </button>
                <button className="rm" onClick={() => removeTrack(track.id)} title="Remove track">
                  ✕
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {track.kind === "caption"
        ? (track.cues || []).map((c) => (
            <CaptionChip key={c.id} id={c.id} start={c.start} end={c.end} text={c.text} pxPerSec={pxPerSec} />
          ))
        : (track.clips || []).map((c) => (
            <ClipView key={c.id} track={track} clip={c} pxPerSec={pxPerSec} />
          ))}
    </div>
  );
}

const snap = (s: number) => Math.round(s / SNAP) * SNAP;

// Collect magnetic snap targets: 0, every other clip's edges, and markers.
function snapPoints(doc: EditDoc, exclude: Set<string>): number[] {
  const pts = [0];
  for (const t of doc.tracks) {
    for (const c of t.clips || []) {
      if (exclude.has(c.id)) continue;
      pts.push(c.start, c.start + (c.out - c.in));
    }
  }
  for (const m of doc.markers || []) pts.push(m.t);
  return pts;
}

// magneticStart snaps a dragged clip's start so that either edge lands on a snap
// point within an 8px tolerance; falls back to the 0.1s grid otherwise. snapAt is
// the point that caught (for the guide line), or null.
function magneticStart(
  rawStart: number,
  dur: number,
  pts: number[],
  pxPerSec: number
): { start: number; snapAt: number | null } {
  const tol = 8 / pxPerSec;
  let best: number | null = null;
  let bestD = tol;
  let snapAt: number | null = null;
  for (const p of pts) {
    const ds = Math.abs(p - rawStart);
    if (ds < bestD) {
      bestD = ds;
      best = p;
      snapAt = p;
    }
    const de = Math.abs(p - (rawStart + dur));
    if (de < bestD) {
      bestD = de;
      best = p - dur;
      snapAt = p;
    }
  }
  return { start: Math.max(0, best != null ? best : snap(rawStart)), snapAt: best != null ? snapAt : null };
}

// magneticScalar snaps a single time (playhead / trim edge) to the nearest point.
function magneticScalar(t: number, pts: number[], pxPerSec: number): { value: number; snapAt: number | null } {
  const tol = 8 / pxPerSec;
  let best = t;
  let bestD = tol;
  let snapAt: number | null = null;
  for (const p of pts) {
    const d = Math.abs(p - t);
    if (d < bestD) {
      bestD = d;
      best = p;
      snapAt = p;
    }
  }
  return { value: Math.max(0, best), snapAt };
}

function ClipView({ track, clip, pxPerSec }: { track: Track; clip: Clip; pxPerSec: number }) {
  const { updateClip, select, toggleSelect, batchUpdateClips, selClips, doc, setPlayhead, setSnapLine } = useStudio();
  const selected = selClips.some((s) => s.clipId === clip.id);
  const kfTimes = clip.keyframes
    ? Array.from(
        new Set(
          [...(clip.keyframes.x || []), ...(clip.keyframes.y || []), ...(clip.keyframes.scale || []), ...(clip.keyframes.opacity || [])].map((k) => k.t)
        )
      ).sort((a, b) => a - b)
    : [];
  const dur = clip.out - clip.in;
  const asset = doc?.assets.find((a) => a.id === clip.assetId);
  const kindClass = clip.title ? "title" : track.kind === "audio" ? "audio" : "";
  const showWave = (track.kind === "audio" || asset?.kind === "audio") && !!doc && !!asset && !clip.title;
  const clipW = Math.max(12, dur * pxPerSec);
  const label = clip.title ? `T ${clip.title.text}` : asset?.name || clip.assetId;
  const thumb = !clip.title && asset?.thumbnail ? mediaUrl(asset.thumbnail) : "";

  // drag move / trim via window pointer listeners
  const startDrag = (mode: "move" | "l" | "r") => (e: React.PointerEvent) => {
    e.stopPropagation();
    // Shift-click toggles this clip in the multi-selection (no drag).
    if (mode === "move" && e.shiftKey) {
      toggleSelect(track.id, clip.id);
      return;
    }
    const inSel = selClips.some((s) => s.clipId === clip.id);
    const group = mode === "move" && inSel && selClips.length > 1;

    // Group move: drag every selected clip by the same delta in one mutation.
    if (group) {
      const x0 = e.clientX;
      const bases = selClips.map((s) => {
        const c = doc?.tracks.find((t) => t.id === s.trackId)?.clips?.find((cc) => cc.id === s.clipId);
        return { trackId: s.trackId, clipId: s.clipId, start: c?.start ?? 0 };
      });
      // Snap the whole group by the dragged clip's snapped delta.
      const draggedBase = clip.start;
      const dragDur = clip.out - clip.in;
      const pts = doc ? snapPoints(doc, new Set(selClips.map((s) => s.clipId))) : [0];
      const move = (ev: PointerEvent) => {
        const d = (ev.clientX - x0) / pxPerSec;
        const r = magneticStart(draggedBase + d, dragDur, pts, pxPerSec);
        const delta = r.start - draggedBase;
        setSnapLine(r.snapAt);
        batchUpdateClips(
          bases.map((b) => ({ trackId: b.trackId, clipId: b.clipId, patch: { start: Math.max(0, b.start + delta) } }))
        );
      };
      const up = () => {
        setSnapLine(null);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      return;
    }

    select(track.id, clip.id);
    const x0 = e.clientX;
    const o = { start: clip.start, in: clip.in, out: clip.out };
    const maxOut = asset && asset.duration > 0 ? asset.duration : Infinity;
    const pts = doc ? snapPoints(doc, new Set([clip.id])) : [0];
    const moveDur = o.out - o.in;
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / pxPerSec;
      if (mode === "move") {
        const r = magneticStart(o.start + d, moveDur, pts, pxPerSec);
        setSnapLine(r.snapAt);
        updateClip(track.id, clip.id, { start: r.start });
      } else if (mode === "l") {
        const r = magneticScalar(o.start + d, pts, pxPerSec); // snap the leading edge
        setSnapLine(r.snapAt);
        const nin = Math.min(Math.max(0, o.in + (r.value - o.start)), o.out - 0.05);
        updateClip(track.id, clip.id, { in: nin, start: Math.max(0, o.start + (nin - o.in)) });
      } else {
        const r = magneticScalar(o.start + (o.out - o.in) + d, pts, pxPerSec); // snap the trailing edge
        setSnapLine(r.snapAt);
        const nout = Math.min(Math.max(o.in + 0.05, o.in + (r.value - o.start)), maxOut);
        updateClip(track.id, clip.id, { out: nout });
      }
    };
    const up = () => {
      setSnapLine(null);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={`tl-clip ${kindClass} ${selected ? "sel" : ""} ${thumb ? "hasthumb" : ""}`}
      style={{
        left: LABEL_W + clip.start * pxPerSec,
        width: clipW,
        ...(thumb ? { backgroundImage: `url(${thumb})`, backgroundSize: "auto 100%", backgroundRepeat: "repeat-x" } : {}),
      }}
      onPointerDown={startDrag("move")}
      title={asset?.name}
    >
      {showWave && (
        <Waveform
          projId={doc!.id}
          assetId={clip.assetId}
          inS={clip.in}
          outS={clip.out}
          duration={asset!.duration}
          width={clipW}
          height={34}
        />
      )}
      <div className="handle l" onPointerDown={startDrag("l")} />
      <div className="clip-title">{label}</div>
      {kfTimes.map((t) => (
        <div
          key={t}
          className="kf-dot"
          style={{ left: t * pxPerSec }}
          title={`keyframe @ ${t.toFixed(2)}s — click to seek`}
          onPointerDown={(e) => {
            e.stopPropagation();
            setPlayhead(clip.start + t);
          }}
        />
      ))}
      <div className="handle r" onPointerDown={startDrag("r")} />
    </div>
  );
}

function CaptionChip({
  id,
  start,
  end,
  text,
  pxPerSec,
}: {
  id: string;
  start: number;
  end: number;
  text: string;
  pxPerSec: number;
}) {
  const { selectCue, selCue, updateCue } = useStudio();
  const startDrag = (e: React.PointerEvent) => {
    e.stopPropagation();
    selectCue(id);
    const x0 = e.clientX;
    const o = { start, end };
    const move = (ev: PointerEvent) => {
      const d = (ev.clientX - x0) / pxPerSec;
      const ns = Math.max(0, snap(o.start + d));
      updateCue(id, { start: ns, end: ns + (o.end - o.start) });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className={`tl-clip caption ${selCue === id ? "sel" : ""}`}
      style={{ left: LABEL_W + start * pxPerSec, width: Math.max(12, (end - start) * pxPerSec) }}
      onPointerDown={startDrag}
      title={text}
    >
      <div className="clip-title">{text}</div>
    </div>
  );
}
