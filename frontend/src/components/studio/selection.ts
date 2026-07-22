// Shared editor selection model — used by StudioView (Inspector) and the new
// Timeline so both target the same clip/lane/cue. Kept in its own module to
// avoid a circular import between the two big components.
import type { Clip, EditDoc } from "../../types";

export type LaneKind = "video" | "audio" | "subtitle";

export type Selection =
  | { kind: "clip"; trackId: string; clipId: string }
  | { kind: "lane"; trackId: string; clipId: string; lane: LaneKind }
  | { kind: "overlay"; trackId: string; clipId: string }
  | { kind: "soundtrack"; trackId: string }
  | { kind: "cue"; cueId: string }
  | { kind: "none" };

// findClip reaches into the live doc for a clip by track + id.
export function findClip(doc: EditDoc | null, trackId: string, clipId: string): Clip | undefined {
  return doc?.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
}
