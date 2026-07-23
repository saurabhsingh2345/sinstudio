import { api } from "./api";
import { autoFrame } from "./autoFrame";
import { SMART_FOCUS_DEFAULTS } from "./smartFocus";
import type { Asset, Clip } from "./types";
import { clipPlayDur } from "./types";
import type { StylePreset } from "./stylePresets";

export interface ApplyStyleResult {
  zooms: number;
  applied: string[];
}

/**
 * Apply a style preset to one clip — backdrop, cursor FX, and optional auto-zoom re-run.
 */
export async function applyStylePreset(
  projectId: string,
  trackId: string,
  clip: Clip,
  asset: Asset,
  preset: StylePreset,
  canvas: { width: number; height: number },
  updateClip: (trackId: string, clipId: string, patch: Partial<Clip>) => void,
): Promise<ApplyStyleResult> {
  const applied: string[] = [];
  const patch: Partial<Clip> = {};

  if (preset.backdrop) {
    patch.backdrop = { ...preset.backdrop };
    applied.push("backdrop");
  }

  if (preset.cursor && asset.hasCursor) {
    patch.cursor = { ...(clip.cursor ?? {}), ...preset.cursor };
    applied.push("cursor");
  }

  if (preset.motionBlur != null && preset.motionBlur > 0) {
    patch.motionBlur = preset.motionBlur;
    applied.push("motion blur");
  }

  let zooms = 0;
  const focusOpts = preset.smartFocus
    ? { ...SMART_FOCUS_DEFAULTS, ...preset.smartFocus }
    : null;

  if (focusOpts && asset.hasCursor) {
    try {
      const { track } = await api.cursorTrack(projectId, asset.id);
      const framed = autoFrame(asset, clip, track as never, clipPlayDur(clip), canvas, focusOpts);
      if (framed) {
        if (framed.patch.keyframes) {
          patch.keyframes = { ...(clip.keyframes ?? {}), ...framed.patch.keyframes };
        }
        // autoFrame's cursor defaults (clicks: {}) are for fresh recordings.
        // When the preset already chose cursor FX, keep those — only take keyframes.
        if (framed.patch.cursor && !preset.cursor) {
          patch.cursor = { ...(clip.cursor ?? {}), ...framed.patch.cursor };
        }
        zooms = framed.zooms;
        if (zooms > 0) applied.push("auto-zoom");
      }
    } catch {
      // Smart-focus re-run is optional polish; a missing sidecar must not block the look.
    }
  }

  if (Object.keys(patch).length) {
    updateClip(trackId, clip.id, patch);
  }

  return { zooms, applied };
}
