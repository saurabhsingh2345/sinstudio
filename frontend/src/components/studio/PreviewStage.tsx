import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Captions,
  BarChart2,
  RotateCw,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { AnnotationLayer } from "./AnnotationLayer";
import { RedactionLayer } from "./RedactionLayer";
import { ChromaVideo } from "./ChromaVideo";
import { DeviceLayer } from "./DeviceLayer";
import { LumaScope } from "./LumaScope";
import { IconBtn } from "./TopBar";
import { deviceLayout } from "../../device";
import { backdropCSS, backdropLayout } from "../../backdrop";
import { bubbleLayout } from "../../bubble";
import { watermarkLayout, watermarkOpacity } from "../../watermark";
import { trackBackgroundCSS } from "../../trackBackground";
import { useStudio } from "../../state";
import type { EditDoc } from "../../types";
import { clipPlayDur, clipSrcDur, clickTimelineAt, mediaUrl } from "../../types";
import { revealedText } from "../../titleAnim";
import { getPeaks } from "../../peaks";
import { getCursorTrack, cursorTrackNow } from "../../cursorTracks";
import { clickTimes, drawCursorFX } from "./cursor-draw";
import { playClicksBetween } from "../../clickAudio";
import { activeVisuals, activeAudios, clipBox, cssFilter, audioLevel } from "./preview-engine";
import { isZoomActive } from "../../zoomPan";
import { isCameraClip } from "../../virtualCamera";
import type { Selection } from "./selection";
import { findClip } from "./selection";
import { captionTrack, clipEnd, fmtTC, type AspectKey } from "./bridge";

export function PreviewStage({ doc, aspect, selection, total }: { doc: EditDoc; aspect: AspectKey; selection: Selection; total: number }) {
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
  const [showScope, setShowScope] = useState(() => localStorage.getItem("studio-scope") === "1");
  const areaRef = useRef<HTMLDivElement>(null);
  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });

  /*
   * Fit the canvas's shape into the space available, in JS.
   *
   * CSS cannot do this: aspect-ratio holds only while ONE axis is constrained,
   * and this box is bounded on both. Setting a width and capping the height
   * makes the browser clamp the height and keep the width — silently breaking
   * the ratio — which is what produced a 2.26-wide frame for a 1.55 canvas and
   * put black bars down both sides of every clip, since the <video> inside is
   * object-fit: contain and letterboxed itself into a box the wrong shape.
   *
   * contentRect rather than clientWidth: it excludes the padding, which is the
   * space the frame must actually fit inside.
   */
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const fit = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return;
      // Bind on whichever axis runs out first, so the whole frame is visible.
      const byWidth = w / h < ratio;
      setFrameSize(byWidth ? { w, h: w / ratio } : { w: h * ratio, h });
    };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    fit(r.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
        r.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    const ro = new ResizeObserver(([e]) => {
      if (e) fit(e.contentRect.width, e.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio]);

  useLayoutEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const fit = () => setStage({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ratio, frameSize.w, frameSize.h]);

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

  // Click sounds while playing: fire the presses the playhead just crossed.
  // Only during playback — scrubbing past a click should not chirp at you.
  const lastPlayhead = useRef(playhead);
  useEffect(() => {
    const prev = lastPlayhead.current;
    lastPlayhead.current = playhead;
    if (!playing) return;
    for (const { clip } of visuals) {
      const snd = clip.cursor?.sound;
      if (!snd) continue;
      const track = cursorTrackNow(doc.id, clip.assetId);
      if (!track) continue;
      playClicksBetween(
        clickTimes(track.samples).map((t) => clickTimelineAt(clip, t)),
        prev,
        playhead,
        snd.style ?? "click",
        snd.volume ?? 0.35
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, playing]);

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
      const asset = doc.assets.find((a) => a.id === clip.assetId);
      const camera = isCameraClip(clip, asset);
      const videoSize = asset ? { width: asset.width || W, height: asset.height || H } : undefined;
      const box = clipBox(clip, playhead, stage.w, stage.h, W, H, videoSize, camera);
      const localT = playhead - clip.start;
      const v = videoRefs.current[clip.id];
      const mediaT = v && v.readyState >= 2 ? v.currentTime : undefined;
      drawCursorFX(ctx, clip, track, box, localT, stage.w / W, asset, camera, mediaT);
    }

    const cue = captionTrack(doc)?.cues?.find((c) => playhead >= c.start && playhead < c.end);
    if (cue) {
      const size = (cue.style.size / H) * stage.h;
      ctx.font = `600 ${size}px Inter, sans-serif`;
      ctx.textAlign = cue.style.align === "left" ? "left" : cue.style.align === "right" ? "right" : "center";
      ctx.textBaseline = "middle";
      const x = cue.style.align === "left" ? stage.w * 0.08 : cue.style.align === "right" ? stage.w * 0.92 : stage.w / 2;
      const y = cue.style.posY * stage.h;
      const lines = cue.text.split("\n");
      const lineH = size * 1.25;
      const blockH = lines.length * lineH;
      const top = y - blockH / 2 + lineH / 2;
      if (cue.style.background) {
        const padX = size * 0.45;
        const padY = size * 0.25;
        let maxW = 0;
        for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
        const boxW = maxW + padX * 2;
        const boxH = blockH + padY * 2 - (lineH - size);
        let boxX = x - boxW / 2;
        if (cue.style.align === "left") boxX = x - padX;
        if (cue.style.align === "right") boxX = x - boxW + padX;
        ctx.fillStyle = cue.style.background;
        ctx.beginPath();
        ctx.roundRect(boxX, top - size / 2 - padY, boxW, boxH, size * 0.2);
        ctx.fill();
      }
      ctx.fillStyle = cue.style.color || "#fff";
      if (cue.style.stroke) {
        ctx.strokeStyle = cue.style.stroke;
        ctx.lineWidth = size / 8;
      }
      lines.forEach((line, i) => {
        const ly = top + i * lineH;
        if (cue.style.stroke) ctx.strokeText(line, x, ly);
        ctx.fillText(line, x, ly);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playhead, stage, doc, H, W, visualsKey]);

  const bgTrack = doc.tracks.find((t) => t.kind === "background");
  const bg = trackBackgroundCSS(bgTrack);
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
        ref={areaRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden p-6"
        style={{ background: "radial-gradient(ellipse at center, var(--stage), var(--stage-2))" }}
      >
        <div
          className="relative shadow-[0_20px_80px_-20px_rgba(0,0,0,0.8)]"
          style={{
            // Explicit px, computed above. The frame is exactly the canvas's
            // shape, so a clip that fills the canvas fills the frame and there
            // is nothing for the background to show through.
            width: frameSize.w || undefined,
            height: frameSize.h || undefined,
            aspectRatio: frameSize.w ? undefined : ratio,
          }}
        >
          <div ref={frameRef} className="absolute inset-0 overflow-hidden rounded-lg" style={{ background: bg }}>
            <LumaScope
              visible={showScope}
              frameRef={frameRef}
              videoRefs={videoRefs}
              visuals={visuals}
              playhead={playhead}
              stage={stage}
              canvasW={W}
              canvasH={H}
              bg={bg}
            />
            {visuals.map(({ track, clip }) => {
              const asset = doc.assets.find((a) => a.id === clip.assetId);
              const camera = isCameraClip(clip, asset);
              const videoSize = asset ? { width: asset.width || W, height: asset.height || H } : undefined;
              const zoomed = isZoomActive(clip, playhead);
              const box = clipBox(clip, playhead, stage.w, stage.h, W, H, videoSize, camera);
              const fit = camera ? "cover" : zoomed ? "cover" : "contain";
              if (clip.annotation) {
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
                      pointerEvents: "none",
                      transform: box.rotation ? `rotate(${box.rotation}deg)` : undefined,
                    }}
                  >
                    <AnnotationLayer anno={clip.annotation} width={box.vw} height={box.vh} />
                  </div>
                );
              }
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
              const muted = !!track.muted || (soloActive && !track.solo) || !!clip.mute;
              const media =
                asset.kind === "image" ? (
                  <img key={clip.id} src={mediaUrl(asset.path, asset.createdAt)} style={{ position: "absolute", ...style, objectFit: fit }} />
                ) : clip.chroma ? (
                  // CSS cannot make a colour transparent, so a keyed clip is
                  // drawn through a shader rather than approximated. The <video>
                  // still exists and is still driven by the preview engine.
                  <ChromaVideo
                    key={clip.id}
                    src={mediaUrl(asset.path, asset.createdAt)}
                    muted={muted}
                    style={style}
                    chroma={clip.chroma}
                    onVideo={(el) => (videoRefs.current[clip.id] = el)}
                  />
                ) : (
                  <video
                    key={clip.id}
                    ref={(el) => (videoRefs.current[clip.id] = el)}
                    src={mediaUrl(asset.path, asset.createdAt)}
                    // The thumbnail stands in until the first frame decodes.
                    // Without it a freshly-opened project is a black rectangle
                    // for as long as the media takes to load, which reads as a
                    // broken recording rather than as one still arriving.
                    poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                    muted={muted}
                    playsInline
                    style={{ position: "absolute", ...style, objectFit: fit }}
                  />
                );
              if (clip.bubble && !clip.device) {
                /*
                 * Webcam bubble: centre-cropped square (object-fit: cover on a
                 * square box = the exporter's crop), masked round, ring and
                 * shadow — positioned by the SAME bubbleLayout the exporter
                 * composites into, scaled from canvas px to stage px.
                 */
                const g = bubbleLayout(clip.bubble, W, H);
                const pct = (v: number, of: number) => `${(v / of) * 100}%`;
                const k = box.vw / W;
                const shadow = clip.bubble.shadow || 0.5;
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
                      transform: rot ? `rotate(${rot}deg)` : undefined,
                      background: clip.backdrop ? backdropCSS(clip.backdrop) : undefined,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: pct(g.x, W),
                        top: pct(g.y, H),
                        width: pct(g.d, W),
                        height: pct(g.d, H),
                        borderRadius: g.radius * k,
                        overflow: "hidden",
                        boxSizing: "border-box",
                        border: g.border > 0 ? `${g.border * k}px solid ${clip.bubble.borderColor || "#ffffff"}` : undefined,
                        boxShadow: `0 ${H * 0.008 * k}px ${H * 0.025 * k}px rgba(0,0,0,${(0.4 * shadow).toFixed(3)})`,
                        background: "#000",
                      }}
                    >
                      <video
                        ref={(el) => (videoRefs.current[clip.id] = el)}
                        src={mediaUrl(asset.path, asset.createdAt)}
                        poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                        muted={muted}
                        playsInline
                        style={{ width: "100%", height: "100%", objectFit: "cover" }}
                      />
                    </div>
                  </div>
                );
              }
              if (camera) {
                const inner =
                  asset.kind === "image" ? (
                    <img src={mediaUrl(asset.path, asset.createdAt)} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                  ) : (
                    <video
                      ref={(el) => (videoRefs.current[clip.id] = el)}
                      src={mediaUrl(asset.path, asset.createdAt)}
                      poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                      muted={muted}
                      playsInline
                      style={{ width: "100%", height: "100%", objectFit: "cover" }}
                    />
                  );
                return (
                  <div
                    key={clip.id}
                    style={{
                      position: "absolute",
                      inset: 0,
                      overflow: "hidden",
                      opacity: box.opacity,
                      pointerEvents: "none",
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: box.left,
                        top: box.top,
                        width: box.vw,
                        height: box.vh,
                        transform: rot ? `rotate(${rot}deg)` : undefined,
                        filter: cssFilter(clip.effects, stage.h, H),
                      }}
                    >
                      {inner}
                    </div>
                  </div>
                );
              }
              if (clip.backdrop && !clip.device) {
                /*
                 * The scene: wallpaper across the whole clip box, the picture
                 * inset into the card the SAME layout the exporter composites
                 * into (backdropLayout, golden-tested in both languages), with
                 * the corner radius and shadow scaled from canvas px to stage
                 * px so they match the export at any preview size.
                 */
                const g = backdropLayout(clip.backdrop, asset.width || W, asset.height || H, W, H);
                const pct = (v: number, of: number) => `${(v / of) * 100}%`;
                const k = box.vw / W;
                const shadow = clip.backdrop.shadow || 0.55;
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
                      transform: rot ? `rotate(${rot}deg)` : undefined,
                      background: backdropCSS(clip.backdrop),
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: pct(g.x, W),
                        top: pct(g.y, H),
                        width: pct(g.w, W),
                        height: pct(g.h, H),
                        borderRadius: g.radius * k,
                        overflow: "hidden",
                        // Black behind the picture: what the export pads a
                        // mismatched source with inside the card.
                        background: "#000",
                        boxShadow: `0 ${H * 0.012 * k}px ${H * 0.03 * k}px rgba(0,0,0,${(0.42 * shadow).toFixed(3)})`,
                      }}
                    >
                      {asset.kind === "image" ? (
                        <img
                          src={mediaUrl(asset.path, asset.createdAt)}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <video
                          ref={(el) => (videoRefs.current[clip.id] = el)}
                          src={mediaUrl(asset.path, asset.createdAt)}
                          poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                          muted={muted}
                          playsInline
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      )}
                    </div>
                  </div>
                );
              }
              if (clip.device) {
                // The picture goes in the screen opening and the frame goes over
                // it, both positioned from the SAME layout the exporter pads
                // against — so what is framed here is what is framed there.
                const scr = deviceLayout(clip.device.kind, W, H);
                const pct = (v: number, of: number) => `${(v / of) * 100}%`;
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
                      transform: rot ? `rotate(${rot}deg)` : undefined,
                      // A backdrop under a device supplies the wallpaper only.
                      background: clip.backdrop ? backdropCSS(clip.backdrop) : undefined,
                    }}
                  >
                    <div
                      style={{
                        position: "absolute",
                        left: pct(scr.x, W),
                        top: pct(scr.y, H),
                        width: pct(scr.w, W),
                        height: pct(scr.h, H),
                        overflow: "hidden",
                        // Black behind the picture, because that is what the
                        // export pads the screen with when shapes differ.
                        background: "#000",
                      }}
                    >
                      {asset.kind === "image" ? (
                        <img
                          src={mediaUrl(asset.path, asset.createdAt)}
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      ) : (
                        <video
                          ref={(el) => (videoRefs.current[clip.id] = el)}
                          src={mediaUrl(asset.path, asset.createdAt)}
                          poster={asset.thumbnail ? mediaUrl(asset.thumbnail, asset.createdAt) : undefined}
                          muted={muted}
                          playsInline
                          style={{ width: "100%", height: "100%", objectFit: "contain" }}
                        />
                      )}
                    </div>
                    <DeviceLayer device={clip.device} canvasW={W} canvasH={H} />
                  </div>
                );
              }
              const redactions = clip.redactions ?? [];
              if (!redactions.length) return media;
              // A sibling rather than a wrapper: the media element keeps its ref
              // and styles untouched, and painting right after it puts the
              // redaction over this clip but still under any clip above it.
              return (
                <Fragment key={clip.id}>
                  {media}
                  <div
                    style={{
                      position: "absolute",
                      left: box.left,
                      top: box.top,
                      width: box.vw,
                      height: box.vh,
                      transform: rot ? `rotate(${rot}deg)` : undefined,
                      pointerEvents: "none",
                    }}
                  >
                    <RedactionLayer
                      redactions={redactions}
                      width={box.vw}
                      height={box.vh}
                      sourceWidth={asset.width}
                    />
                  </div>
                </Fragment>
              );
            })}

            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />

            {doc.watermark &&
              (() => {
                // Over everything, exactly where the exporter overlays it —
                // same layout function, canvas px scaled to stage px.
                const wa = doc.assets.find((a) => a.id === doc.watermark!.assetId);
                if (!wa) return null;
                const g = watermarkLayout(doc.watermark, wa.width, wa.height, W, H);
                const k = stage.w / W;
                return (
                  <img
                    src={mediaUrl(wa.path, wa.createdAt)}
                    alt=""
                    className="pointer-events-none absolute"
                    style={{
                      left: g.x * k,
                      top: g.y * k,
                      width: g.w * k,
                      height: g.h * k,
                      opacity: watermarkOpacity(doc.watermark),
                    }}
                  />
                );
              })()}

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

        <Chip
          active={showScope}
          onClick={() => {
            setShowScope((v) => {
              const next = !v;
              localStorage.setItem("studio-scope", next ? "1" : "0");
              return next;
            });
          }}
          title="Toggle luma histogram scope"
        >
          <BarChart2 className="h-3 w-3" /> Scope
        </Chip>

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

function Chip({ children, active, onClick, title }: { children: React.ReactNode; active?: boolean; onClick?: () => void; title?: string }) {
  return (
    <button
      type="button"
      title={title}
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
