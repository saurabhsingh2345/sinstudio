import { api } from "./api";

// Shared per-asset waveform peaks. The Timeline draws them; the level meter reads
// them synchronously at the playhead. Cleared on project switch so it doesn't grow
// across sessions or serve peaks from a different project.
const promises = new Map<string, Promise<number[]>>();
const resolved = new Map<string, number[]>();

const key = (projId: string, assetId: string) => `${projId}:${assetId}`;

// getPeaks fetches (once) and resolves an asset's normalized peak array.
export function getPeaks(projId: string, assetId: string): Promise<number[]> {
  const k = key(projId, assetId);
  if (!promises.has(k)) {
    promises.set(
      k,
      api
        .waveform(projId, assetId)
        .then((r) => {
          resolved.set(k, r.peaks);
          return r.peaks;
        })
        .catch(() => {
          resolved.set(k, []);
          return [];
        })
    );
  }
  return promises.get(k)!;
}

// peaksNow returns resolved peaks synchronously, kicking off a fetch on a miss
// (returns undefined until the fetch resolves).
export function peaksNow(projId: string, assetId: string): number[] | undefined {
  const k = key(projId, assetId);
  if (resolved.has(k)) return resolved.get(k);
  void getPeaks(projId, assetId);
  return undefined;
}

export function clearPeaks() {
  promises.clear();
  resolved.clear();
}
