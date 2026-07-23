import { api } from "./api";
import type { CursorSidecar } from "./cursor";

// Shared per-asset pointer tracks, so the preview can draw cursor effects
// without refetching on every frame. Same shape as the waveform cache: the
// draw loop reads synchronously and a miss kicks off the fetch.
//
// null is a real, cached answer — "this asset has no pointer track" — and is
// the common case. Without distinguishing it from "not yet fetched" the preview
// would re-request the same absent sidecar on every repaint.
const promises = new Map<string, Promise<CursorSidecar | null>>();
const resolved = new Map<string, CursorSidecar | null>();

const key = (projId: string, assetId: string) => `${projId}:${assetId}`;

export function getCursorTrack(projId: string, assetId: string): Promise<CursorSidecar | null> {
  const k = key(projId, assetId);
  if (!promises.has(k)) {
    promises.set(
      k,
      api
        .cursorTrack(projId, assetId)
        .then((r) => {
          const track = (r.track as CursorSidecar | null) ?? null;
          resolved.set(k, track);
          return track;
        })
        .catch(() => {
          resolved.set(k, null);
          return null;
        })
    );
  }
  return promises.get(k)!;
}

/** Resolved track, or undefined while the first fetch is in flight. */
export function cursorTrackNow(projId: string, assetId: string): CursorSidecar | null | undefined {
  const k = key(projId, assetId);
  if (resolved.has(k)) return resolved.get(k);
  void getCursorTrack(projId, assetId);
  return undefined;
}

export function clearCursorTracks() {
  promises.clear();
  resolved.clear();
}
