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
  // A screen recording is the case that suffered most from short holds: the
  // pointer is busy, so events are frequent, and at 0.9 the camera arrived and
  // left again before the viewer had read anything. This is the main reason
  // auto-framing read as "too much zooming in and out" — the count of zooms,
  // not the depth of any one of them.
  minHold: 1.8,
  dwellTime: 0.75,
  revisitStep: 0.14,
  revisitMax: 1.62,
  followDamping: 0.24,
  followInterval: 0.58,
  // The strongest anti-jitter knob there is: nothing moves at all until the
  // pointer has genuinely gone somewhere. A screen recording's pointer is never
  // still — it twitches while reading, overshoots and corrects — and following
  // any of that is what reads as an unsteady camera. Roughly a seventh of the
  // frame, so crossing to another panel moves the camera and working within one
  // does not.
  followDeadzone: 280,
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
