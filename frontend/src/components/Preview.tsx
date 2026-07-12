import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useStudio, projectDuration } from "../state";
import { mediaUrl, type Clip, type Track } from "../types";

const DEF_TRANS = 0.5; // matches render's defTransDur

const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

// Interpolate a keyframed property at clip-local time (piecewise-linear, held
// outside the keyed range). Mirrors render.kfExpr.
function kfValue(keys: { t: number; value: number }[], localT: number): number {
  const s = [...keys].sort((a, b) => a.t - b.t);
  if (localT <= s[0].t) return s[0].value;
  const last = s[s.length - 1];
  if (localT >= last.t) return last.value;
  for (let i = 0; i < s.length - 1; i++) {
    if (localT < s[i + 1].t) {
      const a = s[i];
      const b = s[i + 1];
      return lerp(a.value, b.value, (localT - a.t) / Math.max(1e-3, b.t - a.t));
    }
  }
  return last.value;
}

// clipBox computes a clip's on-stage rectangle + opacity at time t, folding in
// keyframes and transitions so the preview matches the exported render.
function clipBox(clip: Clip, t: number, stageW: number, stageH: number, W: number, H: number) {
  const dur = clip.out - clip.in;
  const start = clip.start;
  const end = start + dur;
  const localT = t - start;
  const vw = stageW * (clip.transform.scale || 1);
  const vh = stageH * (clip.transform.scale || 1);

  // base position (canvas-px offset from center) — keyframes win per axis.
  const kf = clip.keyframes || {};
  const offX = kf.x?.length ? kfValue(kf.x, localT) : clip.transform.x;
  const offY = kf.y?.length ? kfValue(kf.y, localT) : clip.transform.y;
  let left = (stageW - vw) / 2 + (offX / W) * stageW;
  let top = (stageH - vh) / 2 + (offY / H) * stageH;

  // slide transitions (only when that axis isn't keyframed) ramp from/to an edge.
  const slide = (tr: { type: string; duration: number } | undefined, entering: boolean) => {
    if (!tr) return;
    const d = tr.duration > 0 ? tr.duration : DEF_TRANS;
    if (entering ? t > start + d : t < end - d) return; // outside the ramp window
    const u = entering ? clamp01(localT / d) : clamp01((t - (end - d)) / d);
    const mix = (target: number, edge: number) => (entering ? lerp(edge, target, u) : lerp(target, edge, u));
    switch (tr.type) {
      case "slide-left":
        if (!kf.x?.length) left = mix(left, -vw);
        break;
      case "slide-right":
        if (!kf.x?.length) left = mix(left, stageW);
        break;
      case "slide-top":
        if (!kf.y?.length) top = mix(top, -vh);
        break;
      case "slide-bottom":
        if (!kf.y?.length) top = mix(top, stageH);
        break;
    }
  };
  slide(clip.transitionIn, true);
  slide(clip.transitionOut, false);

  // opacity: base × fade/dissolve (and explicit fades) ramps.
  const isFade = (ty?: string) => ty === "fade" || ty === "dissolve";
  const alphaIn = Math.max(clip.fadeIn || 0, isFade(clip.transitionIn?.type) ? clip.transitionIn!.duration || DEF_TRANS : 0);
  const alphaOut = Math.max(clip.fadeOut || 0, isFade(clip.transitionOut?.type) ? clip.transitionOut!.duration || DEF_TRANS : 0);
  let opacity = kf.opacity?.length ? kfValue(kf.opacity, localT) : clip.transform.opacity || 1;
  if (alphaIn > 0 && t < start + alphaIn) opacity *= clamp01((t - start) / alphaIn);
  if (alphaOut > 0 && t > end - alphaOut) opacity *= clamp01((end - t) / alphaOut);

  return { left, top, vw, vh, opacity };
}

// cssFilter approximates a clip's effects as a CSS filter string for the preview
// (the ffmpeg eq/hue/gblur export is authoritative). blur sigma (canvas px) is
// scaled to the stage.
function cssFilter(e: Clip["effects"], stageH: number, H: number): string | undefined {
  if (!e) return undefined;
  const parts: string[] = [];
  if (e.brightness) parts.push(`brightness(${(1 + e.brightness).toFixed(3)})`);
  if (e.contrast != null && e.contrast !== 1) parts.push(`contrast(${e.contrast.toFixed(3)})`);
  if (e.saturation != null && e.saturation !== 1) parts.push(`saturate(${e.saturation.toFixed(3)})`);
  if (e.hue) parts.push(`hue-rotate(${e.hue.toFixed(1)}deg)`);
  if (e.blur) parts.push(`blur(${(e.blur * (stageH / H)).toFixed(2)}px)`);
  return parts.length ? parts.join(" ") : undefined;
}

// Visual clips active at time t, ordered bottom->top (bg, video, overlay).
function activeVisuals(tracks: Track[], t: number) {
  const order: Record<string, number> = { background: 0, video: 1, overlay: 2 };
  const out: { track: Track; clip: Clip }[] = [];
  for (const tr of tracks) {
    if (tr.hidden || !(tr.kind in order)) continue;
    for (const c of tr.clips || []) {
      const end = c.start + (c.out - c.in);
      if (t >= c.start && t < end) out.push({ track: tr, clip: c });
    }
  }
  out.sort((a, b) => order[a.track.kind] - order[b.track.kind]);
  return out;
}

// Audio-track clips audible at time t, honoring mute/hide/solo.
function activeAudios(tracks: Track[], t: number, soloActive: boolean) {
  const out: { track: Track; clip: Clip }[] = [];
  for (const tr of tracks) {
    if (tr.kind !== "audio" || tr.muted || tr.hidden) continue;
    if (soloActive && !tr.solo) continue;
    for (const c of tr.clips || []) {
      const end = c.start + (c.out - c.in);
      if (t >= c.start && t < end) out.push({ track: tr, clip: c });
    }
  }
  return out;
}

export function Preview() {
  const { doc, playhead, playing, setPlayhead, setPlaying, addCue } = useStudio();
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRefs = useRef<Record<string, HTMLVideoElement | null>>({});
  const audioRefs = useRef<Record<string, HTMLAudioElement | null>>({});
  const [stage, setStage] = useState({ w: 640, h: 360 });

  const W = doc?.canvas.width || 1920;
  const H = doc?.canvas.height || 1080;
  const total = doc ? projectDuration(doc) : 0;

  // fit stage into the wrap preserving aspect
  useLayoutEffect(() => {
    const fit = () => {
      const el = wrapRef.current;
      if (!el) return;
      const cw = el.clientWidth - 20;
      const ch = el.clientHeight - 20;
      const s = Math.min(cw / W, ch / H);
      setStage({ w: Math.max(80, W * s), h: Math.max(45, H * s) });
    };
    fit();
    const ro = new ResizeObserver(fit);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [W, H]);

  // playback clock
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = useStudio.getState().playhead + dt;
      if (next >= total) {
        useStudio.getState().setPlayhead(total);
        useStudio.getState().setPlaying(false);
        return;
      }
      useStudio.getState().setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  const soloActive = !!doc?.tracks.some((t) => t.solo);
  const visuals = doc ? activeVisuals(doc.tracks, playhead) : [];
  const audios = doc ? activeAudios(doc.tracks, playhead, soloActive) : [];

  // sync video elements to the playhead
  useEffect(() => {
    for (const { track, clip } of visuals) {
      const v = videoRefs.current[clip.id];
      if (!v) continue;
      v.muted = !!track.muted || (soloActive && !track.solo);
      const local = playhead - clip.start + clip.in;
      if (Math.abs(v.currentTime - local) > 0.25) {
        try {
          v.currentTime = local;
        } catch {}
      }
      if (playing && v.paused) v.play().catch(() => {});
      if (!playing && !v.paused) v.pause();
    }
  }, [playhead, playing, soloActive, visuals.map((x) => x.clip.id).join(",")]);

  // sync audio-track elements (music) to the playhead
  useEffect(() => {
    for (const { clip } of audios) {
      const a = audioRefs.current[clip.id];
      if (!a) continue;
      a.volume = Math.max(0, Math.min(1, clip.volume || 1));
      const local = playhead - clip.start + clip.in;
      if (Math.abs(a.currentTime - local) > 0.25) {
        try {
          a.currentTime = local;
        } catch {}
      }
      if (playing && a.paused) a.play().catch(() => {});
      if (!playing && !a.paused) a.pause();
    }
  }, [playhead, playing, audios.map((x) => x.clip.id).join(",")]);

  // draw captions
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv || !doc) return;
    cv.width = stage.w;
    cv.height = stage.h;
    const ctx = cv.getContext("2d")!;
    ctx.clearRect(0, 0, cv.width, cv.height);
    const capTrack = doc.tracks.find((t) => t.kind === "caption");
    const cue = capTrack?.cues?.find((c) => playhead >= c.start && playhead < c.end);
    if (cue) {
      const size = (cue.style.size / H) * stage.h;
      ctx.font = `600 ${size}px Inter, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = cue.style.color || "#fff";
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.lineWidth = size / 8;
      const x = stage.w / 2;
      const y = cue.style.posY * stage.h;
      ctx.strokeText(cue.text, x, y);
      ctx.fillText(cue.text, x, y);
    }
  }, [playhead, stage, doc]);

  const bg = doc?.tracks.find((t) => t.kind === "background")?.backgroundColor || "#000";

  return (
    <>
      <div className="preview-wrap" ref={wrapRef}>
        <div className="preview-stage" style={{ width: stage.w, height: stage.h }}>
          <div className="bg" style={{ background: bg }} />
          {visuals.map(({ track, clip }) => {
            const box = clipBox(clip, playhead, stage.w, stage.h, W, H);
            // Title clips have no asset — render styled text on the scaled layer.
            if (clip.title) {
              const t = clip.title;
              const fs = (t.size * box.vh) / 1080;
              return (
                <div
                  key={clip.id}
                  style={{ position: "absolute", left: box.left, top: box.top, width: box.vw, height: box.vh, opacity: box.opacity, overflow: "hidden", pointerEvents: "none" }}
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
                    }}
                  >
                    {t.text}
                  </div>
                </div>
              );
            }
            const asset = doc!.assets.find((a) => a.id === clip.assetId);
            if (!asset) return null;
            const style = {
              width: box.vw,
              height: box.vh,
              left: box.left,
              top: box.top,
              opacity: box.opacity,
              filter: cssFilter(clip.effects, stage.h, H),
            };
            if (asset.kind === "image") {
              return <img key={clip.id} src={mediaUrl(asset.path)} style={{ position: "absolute", ...style, objectFit: "contain" }} />;
            }
            return (
              <video
                key={clip.id}
                ref={(el) => (videoRefs.current[clip.id] = el)}
                src={mediaUrl(asset.path)}
                muted={!!track.muted || (soloActive && !track.solo)}
                playsInline
                style={{ position: "absolute", ...style }}
              />
            );
          })}
          <canvas ref={canvasRef} className="caption" />
          {audios.map(({ clip }) => {
            const asset = doc!.assets.find((a) => a.id === clip.assetId);
            if (!asset) return null;
            return (
              <audio key={clip.id} ref={(el) => (audioRefs.current[clip.id] = el)} src={mediaUrl(asset.path)} preload="auto" />
            );
          })}
        </div>
      </div>

      <div className="transport">
        <button onClick={() => setPlaying(!playing)}>{playing ? "❚❚ Pause" : "▶ Play"}</button>
        <button onClick={() => setPlayhead(0)}>⏮ Start</button>
        <span className="time">
          {playhead.toFixed(2)}s / {total.toFixed(2)}s
        </span>
        <div style={{ flex: 1 }} />
        <button onClick={addCue}>+ Caption @ playhead</button>
      </div>
    </>
  );
}
