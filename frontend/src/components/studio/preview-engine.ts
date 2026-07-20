// preview-engine — pure compositing math shared by the studio preview. Extracted
// from the original Preview.tsx so the new PreviewStage renders frames that match
// the exported render. Keep in sync with backend/internal/render.
import { clipPlayDur, type Clip, type Track } from "../../types";
import { ease } from "../../ease";
import { peaksNow } from "../../peaks";

export const DEF_TRANS = 0.5; // matches render's defTransDur

export const clamp01 = (u: number) => Math.max(0, Math.min(1, u));
export const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

// Interpolate a keyframed property at clip-local time (piecewise, eased per the
// left keyframe's curve, held outside the keyed range). Mirrors render.kfExpr.
export function kfValue(keys: { t: number; value: number; ease?: string }[], localT: number): number {
  const s = [...keys].sort((a, b) => a.t - b.t);
  if (localT <= s[0].t) return s[0].value;
  const last = s[s.length - 1];
  if (localT >= last.t) return last.value;
  for (let i = 0; i < s.length - 1; i++) {
    if (localT < s[i + 1].t) {
      const a = s[i];
      const b = s[i + 1];
      const p = (localT - a.t) / Math.max(1e-3, b.t - a.t);
      return lerp(a.value, b.value, ease(a.ease, p));
    }
  }
  return last.value;
}

// clipBox computes a clip's on-stage rectangle + opacity at time t, folding in
// keyframes and transitions so the preview matches the exported render.
export function clipBox(clip: Clip, t: number, stageW: number, stageH: number, W: number, H: number) {
  const dur = clipPlayDur(clip);
  const start = clip.start;
  const end = start + dur;
  const localT = t - start;

  const kf = clip.keyframes || {};
  const scaleMul = kf.scale?.length ? Math.max(0, kfValue(kf.scale, localT)) : clip.transform.scale || 1;
  const vw = stageW * scaleMul;
  const vh = stageH * scaleMul;

  const offX = kf.x?.length ? kfValue(kf.x, localT) : clip.transform.x;
  const offY = kf.y?.length ? kfValue(kf.y, localT) : clip.transform.y;
  let left = (stageW - vw) / 2 + (offX / W) * stageW;
  let top = (stageH - vh) / 2 + (offY / H) * stageH;

  const slide = (tr: { type: string; duration: number } | undefined, entering: boolean) => {
    if (!tr) return;
    const d = tr.duration > 0 ? tr.duration : DEF_TRANS;
    if (entering ? t > start + d : t < end - d) return;
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

  const isFade = (ty?: string) => ty === "fade" || ty === "dissolve";
  const alphaIn = Math.max(clip.fadeIn || 0, isFade(clip.transitionIn?.type) ? clip.transitionIn!.duration || DEF_TRANS : 0);
  const alphaOut = Math.max(clip.fadeOut || 0, isFade(clip.transitionOut?.type) ? clip.transitionOut!.duration || DEF_TRANS : 0);
  let opacity = kf.opacity?.length ? kfValue(kf.opacity, localT) : clip.transform.opacity || 1;
  if (alphaIn > 0 && t < start + alphaIn) opacity *= clamp01((t - start) / alphaIn);
  if (alphaOut > 0 && t > end - alphaOut) opacity *= clamp01((end - t) / alphaOut);

  return { left, top, vw, vh, opacity };
}

// cssFilter approximates a clip's effects as a CSS filter string for the preview
// (the ffmpeg eq/hue/gblur export is authoritative).
export function cssFilter(e: Clip["effects"], stageH: number, H: number): string | undefined {
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
export function activeVisuals(tracks: Track[], t: number) {
  const order: Record<string, number> = { background: 0, video: 1, overlay: 2 };
  const out: { track: Track; clip: Clip }[] = [];
  for (const tr of tracks) {
    if (tr.hidden || !(tr.kind in order)) continue;
    for (const c of tr.clips || []) {
      if (c.disabled) continue;
      const end = c.start + clipPlayDur(c);
      if (t >= c.start && t < end) out.push({ track: tr, clip: c });
    }
  }
  out.sort((a, b) => order[a.track.kind] - order[b.track.kind]);
  return out;
}

// Audio-track clips audible at time t, honoring mute/hide/solo.
export function activeAudios(tracks: Track[], t: number, soloActive: boolean) {
  const out: { track: Track; clip: Clip }[] = [];
  for (const tr of tracks) {
    if (tr.kind !== "audio" || tr.muted || tr.hidden) continue;
    if (soloActive && !tr.solo) continue;
    for (const c of tr.clips || []) {
      if (c.disabled) continue;
      const end = c.start + clipPlayDur(c);
      if (t >= c.start && t < end) out.push({ track: tr, clip: c });
    }
  }
  return out;
}

// audioLevel approximates the summed source level (0..1) at time t from cached
// waveform peaks × per-clip volume. Returns 0 when peaks aren't cached yet.
export function audioLevel(
  projId: string,
  assets: { id: string; duration: number }[],
  audios: { clip: Clip }[],
  t: number
): number {
  let sum = 0;
  for (const { clip } of audios) {
    const asset = assets.find((a) => a.id === clip.assetId);
    if (!asset || !asset.duration) continue;
    const peaks = peaksNow(projId, asset.id);
    if (!peaks || !peaks.length) continue;
    const sp = clip.speed && clip.speed > 0 ? clip.speed : 1;
    const frac = (clip.in + (t - clip.start) * sp) / asset.duration;
    if (frac < 0 || frac > 1) continue;
    const idx = Math.min(peaks.length - 1, Math.max(0, Math.floor(frac * peaks.length)));
    sum += peaks[idx] * (clip.volume ?? 1);
  }
  return Math.min(1, sum);
}
