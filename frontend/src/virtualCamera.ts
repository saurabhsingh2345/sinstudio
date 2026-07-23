import type { Asset, Clip } from "./types";
import type { SmartFocusOptions } from "./smartFocus";

/**
 * Virtual-camera tuning for screen recordings — separate from SMART_FOCUS_DEFAULTS
 * so imports and hand-placed zooms keep their existing feel.
 *
 * Does NOT include hover-depth escalation; that lived in a separate experiment
 * and is intentionally omitted here.
 */
export const VIRTUAL_CAMERA_OPTS: Partial<SmartFocusOptions> = {
  zoom: 1.26,
  ramp: 0.95,
  minHold: 0.9,
  dwellTime: 0.75,
  revisitStep: 0.14,
  revisitMax: 1.62,
  followDamping: 0.24,
  followInterval: 0.58,
  ease: "easeInOut",
  cameraViewport: true,
};

/** Screen recording on the timeline — not a styled import with auto-zoom keyframes. */
export function isCameraClip(
  clip: Pick<Clip, "backdrop" | "device" | "chroma" | "bubble">,
  asset?: Pick<Asset, "hasCursor">
): boolean {
  if (!asset?.hasCursor) return false;
  if (clip.backdrop || clip.device || clip.chroma || clip.bubble) return false;
  return true;
}
