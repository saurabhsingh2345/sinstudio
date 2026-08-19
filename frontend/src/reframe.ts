import type { CursorSidecar } from "./cursor";
import { SMART_FOCUS_DEFAULTS, smartFocus, type SmartFocusOptions } from "./smartFocus";
import { VIRTUAL_CAMERA_OPTS } from "./virtualCamera";
import { clipPlayDur, type Asset, type Clip, type EditDoc } from "./types";
import { fillsFrame } from "./crop";

/*
Switching a project between landscape and vertical.

Changing the canvas is one line and produces a video nobody wants: a 16:9 screen
recording dropped into a 1080x1920 frame is a letterbox with two thirds of the
picture missing, and the aspect menu did exactly that. "Vertical" is not a canvas
size, it is a decision about what stays in frame.

So the switch reframes. Anything that would letterbox is filled instead, and any
clip carrying a pointer track has its camera RECOMPUTED for the new frame — the
same smartFocus pass that ran when the recording landed, asked the question again
with a different answer available. In a 9:16 frame there is far less width to
spare, so the camera it finds is a genuinely different one; scaling the old
keyframes would just be the landscape answer stretched.

Everything is one patch list, applied in one mutate, so the whole switch is a
single undo. Half a reframe is worse than none.
*/

export interface ReframePatch {
  trackId: string;
  clipId: string;
  patch: Partial<Clip>;
}

export interface ReframePlan {
  patches: ReframePatch[];
  /** Clips whose camera was recomputed against the new frame. */
  refocused: number;
  /** Clips that were merely told to fill rather than letterbox. */
  filled: number;
}

/** The tolerance render.contentFrac uses; below it a clip is not really barred. */
const ASPECT_EPS = 0.005;

/** Would this source letterbox in this canvas? */
export function wouldLetterbox(
  src: { width?: number; height?: number } | undefined,
  canvas: { width: number; height: number }
): boolean {
  if (!src?.width || !src?.height) return false;
  const canA = canvas.width / canvas.height;
  return Math.abs(src.width / src.height - canA) / canA > ASPECT_EPS;
}

/**
 * Work out what a change of canvas should do to every clip.
 *
 * `track` is looked up synchronously, so the caller is responsible for having
 * fetched the sidecars it wants used — a clip whose track has not been loaded is
 * still filled, just not re-framed, and that is a worse result rather than a
 * wrong one.
 */
export function planReframe(
  doc: EditDoc,
  canvas: { width: number; height: number },
  track: (assetId: string) => CursorSidecar | null | undefined,
  opts: SmartFocusOptions = { ...SMART_FOCUS_DEFAULTS, ...VIRTUAL_CAMERA_OPTS }
): ReframePlan {
  const plan: ReframePlan = { patches: [], refocused: 0, filled: 0 };
  const assets = new Map<string, Asset>(doc.assets?.map((a) => [a.id, a]) ?? []);

  for (const t of doc.tracks) {
    if (t.kind !== "video" && t.kind !== "overlay") continue;
    for (const c of t.clips ?? []) {
      // Titles and callouts are drawn at canvas size to begin with; they follow
      // the new frame on their own and have no picture to crop.
      if (!c.assetId || c.title || c.annotation) continue;
      const asset = assets.get(c.assetId);
      const patch: Partial<Clip> = {};

      // A webcam bubble already fills its own circle, and a clip in a device
      // frame is fitted into the device's screen — neither letterboxes, and
      // telling them to fill would crop the thing they are built around.
      if (!c.bubble && !c.device && wouldLetterbox(asset, canvas)) {
        patch.fit = "fill";
        plan.filled++;
      }

      const side = asset?.hasCursor ? track(c.assetId) : null;
      if (side?.samples?.length) {
        const dur = clipPlayDur(c);
        // Against the fit this clip is ABOUT to have, not the one it has: the
        // patch may be setting it to fill in the same breath.
        const fit = patch.fit ?? c.fit;
        const { keyframes } = smartFocus(side as never, dur, canvas, {
          ...opts,
          cameraViewport: fillsFrame(fit),
        });
        // The old camera is REMOVED rather than merged over. A 16:9 pan that
        // is not replaced in the 9:16 answer would otherwise survive as a
        // half-updated move through a frame it was never computed for.
        const kept: NonNullable<Clip["keyframes"]> = {};
        for (const [k, v] of Object.entries(c.keyframes ?? {})) {
          if (k !== "scale" && k !== "x" && k !== "y") kept[k] = v;
        }
        patch.keyframes = { ...kept, ...keyframes };
        plan.refocused++;
      }

      if (Object.keys(patch).length) {
        plan.patches.push({ trackId: t.id, clipId: c.id, patch });
      }
    }
  }
  return plan;
}

/** One line for the toast, or null when the switch changed nothing but the frame. */
export function reframeSummary(plan: ReframePlan): string | null {
  const bits: string[] = [];
  if (plan.refocused) bits.push(`${plan.refocused} clip${plan.refocused > 1 ? "s" : ""} re-framed`);
  if (plan.filled) bits.push(`${plan.filled} filled to the new frame`);
  return bits.length ? bits.join(", ") : null;
}
