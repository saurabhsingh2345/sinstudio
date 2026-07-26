import type { Clip } from "./types";

/**
 * Stacking of the clips WITHIN one track. Track kind (background < video <
 * overlay) and track order decide first; this only separates siblings — the two
 * logos dropped on the same overlay lane, whose only tiebreak used to be the
 * invisible order they happened to be added in.
 *
 * The backend twin is `byZ` in backend/internal/render/render.go. Both sort by
 * z and break ties on array position, so the export composites what the preview
 * shows.
 */
export function zOrder<T extends Clip>(clips: T[]): T[] {
  return clips
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (a.c.z ?? 0) - (b.c.z ?? 0) || a.i - b.i)
    .map(({ c }) => c);
}

export type RestackMode = "front" | "forward" | "backward" | "back";

/**
 * Move one clip through its track's stack and renumber the result.
 *
 * Renumbering the whole track — rather than nudging the one clip's z — is what
 * makes this total: a duplicated clip that arrived carrying its twin's z, or a
 * hand-authored document with three clips all at z=5, still lands in a definite
 * order, and "front" stays front no matter what is added afterwards.
 *
 * Mutates the clips in place (the store runs it inside an immer draft) and
 * returns true when something actually moved.
 */
export function restack(clips: Clip[], clipId: string, mode: RestackMode): boolean {
  if (!clips || clips.length < 2) return false;
  const order = zOrder(clips);
  const i = order.findIndex((c) => c.id === clipId);
  if (i < 0) return false;
  const to = mode === "front" ? order.length - 1 : mode === "back" ? 0 : mode === "forward" ? i + 1 : i - 1;
  if (to === i || to < 0 || to >= order.length) return false;
  order.splice(to, 0, ...order.splice(i, 1));
  // z=0 is the omitempty default, so the bottom clip carries no z at all and a
  // track that never gets restacked stays exactly as clean as it was.
  order.forEach((c, k) => {
    if (k === 0) delete c.z;
    else c.z = k;
  });
  return true;
}
