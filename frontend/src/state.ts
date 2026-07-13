import { create } from "zustand";
import { api } from "./api";
import type { Asset, CaptionCue, Clip, EditDoc, Track } from "./types";
import { newId, clipPlayDur } from "./types";

interface StudioState {
  doc: EditDoc | null;
  saving: boolean;
  dirty: boolean;
  past: EditDoc[];
  future: EditDoc[];

  // editor UI state
  selClip: { trackId: string; clipId: string } | null; // primary (for Inspector)
  selClips: { trackId: string; clipId: string }[]; // full selection (multi)
  selCue: string | null;
  playhead: number; // seconds
  playing: boolean;
  pxPerSec: number;
  snapLine: number | null; // transient: seconds of the active snap guide (null = hidden)

  load: (id: string) => Promise<void>;
  save: () => Promise<void>;
  mutate: (fn: (d: EditDoc) => void) => void;
  // beginTransient/commitTransient coalesce a burst of mutations (a drag/trim)
  // into a single undo entry: between them, mutate() updates the doc without
  // pushing history; commit records one snapshot for the whole gesture.
  beginTransient: () => void;
  commitTransient: () => void;
  undo: () => void;
  redo: () => void;

  addAsset: (a: Asset) => void;
  removeAsset: (assetId: string) => void;
  addClip: (trackId: string, assetId: string, start: number) => void;
  updateClip: (trackId: string, clipId: string, patch: Partial<Clip>) => void;
  removeClip: (trackId: string, clipId: string) => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
  rippleDelete: () => void;
  copySelected: () => void;
  paste: () => void;
  nudgePlayhead: (delta: number) => void;

  setCues: (cues: CaptionCue[]) => void;
  updateCue: (id: string, patch: Partial<CaptionCue>) => void;
  addCue: () => void;
  removeCue: (id: string) => void;

  setBackground: (color: string) => void;

  addTrack: (kind: "video" | "overlay" | "audio") => void;
  removeTrack: (trackId: string) => void;
  moveTrack: (trackId: string, dir: -1 | 1) => void;
  toggleTrackFlag: (trackId: string, flag: "muted" | "hidden" | "solo" | "duck") => void;

  addKeyframe: (trackId: string, clipId: string, prop: "x" | "y" | "scale" | "opacity") => void;
  updateKeyframe: (trackId: string, clipId: string, prop: string, index: number, value: number) => void;
  setKeyframeEase: (trackId: string, clipId: string, prop: string, index: number, ease: string) => void;
  removeKeyframe: (trackId: string, clipId: string, prop: string, index: number) => void;
  updateEffect: (trackId: string, clipId: string, key: keyof NonNullable<Clip["effects"]>, value: number) => void;
  resetEffects: (trackId: string, clipId: string) => void;
  addTitle: () => void;
  updateTitle: (trackId: string, clipId: string, patch: Partial<NonNullable<Clip["title"]>>) => void;

  addMarker: () => void;
  removeMarker: (id: string) => void;
  updateMarker: (id: string, patch: { t?: number; label?: string; color?: string }) => void;

  select: (trackId: string, clipId: string) => void;
  toggleSelect: (trackId: string, clipId: string) => void;
  batchUpdateClips: (updates: { trackId: string; clipId: string; patch: Partial<Clip> }[]) => void;
  selectCue: (id: string | null) => void;
  setPlayhead: (t: number) => void;
  setPlaying: (p: boolean) => void;
  setZoom: (px: number) => void;
  setSnapLine: (t: number | null) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let clipboard: { trackId: string; clip: Clip }[] = [];
// Non-null while a transient gesture (drag/trim) is open: the pre-gesture doc
// snapshot that will be pushed to history once on commit.
let txnSnapshot: EditDoc | null = null;

export const useStudio = create<StudioState>((set, get) => ({
  doc: null,
  saving: false,
  dirty: false,
  past: [],
  future: [],
  selClip: null,
  selClips: [],
  selCue: null,
  playhead: 0,
  playing: false,
  pxPerSec: 80,
  snapLine: null,

  load: async (id) => {
    const doc = await api.getProject(id);
    set({ doc, dirty: false, past: [], future: [], selClip: null, selClips: [], selCue: null, playhead: 0 });
  },

  save: async () => {
    const doc = get().doc;
    if (!doc) return;
    set({ saving: true });
    try {
      const { version } = await api.saveProject(doc);
      // Merge the server version into the CURRENT doc, not the pre-await snapshot:
      // edits made during the in-flight save must not be clobbered. Only clear the
      // dirty flag if nothing changed while we were saving.
      set((s) => {
        if (!s.doc) return { saving: false };
        const unchanged = s.doc === doc;
        return {
          saving: false,
          dirty: unchanged ? false : s.dirty,
          doc: { ...s.doc, version: Math.max(s.doc.version || 0, version) },
        };
      });
    } catch (e) {
      set({ saving: false });
      console.error("save failed", e);
    }
  },

  // mutate applies fn to a cloned doc, bumps version, records history, autosaves.
  // During a transient gesture, history is not touched (beginTransient captured
  // the one snapshot; commitTransient will push it).
  mutate: (fn) => {
    const cur = get().doc;
    if (!cur) return;
    const doc: EditDoc = structuredClone(cur);
    fn(doc);
    doc.version = (doc.version || 0) + 1;
    if (txnSnapshot) {
      set({ doc, dirty: true, future: [] });
    } else {
      const snapshot: EditDoc = structuredClone(cur);
      set((s) => ({ doc, dirty: true, past: [...s.past, snapshot].slice(-60), future: [] }));
    }
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().save(), 600);
  },

  beginTransient: () => {
    if (txnSnapshot) return; // already open
    const d = get().doc;
    if (d) txnSnapshot = structuredClone(d);
  },

  commitTransient: () => {
    const snap = txnSnapshot;
    txnSnapshot = null;
    if (!snap) return;
    // Only record history if the gesture actually changed something.
    if (get().doc && get().doc!.version !== snap.version) {
      set((s) => ({ past: [...s.past, snap].slice(-60), future: [] }));
    }
  },

  undo: () => {
    const { past, doc } = get();
    if (!past.length || !doc) return;
    const prev = past[past.length - 1];
    const sel = pruneSelection(prev, get());
    set((s) => ({ doc: prev, past: s.past.slice(0, -1), future: [doc, ...s.future].slice(0, 60), dirty: true, ...sel }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().save(), 600);
  },

  redo: () => {
    const { future, doc } = get();
    if (!future.length || !doc) return;
    const next = future[0];
    const sel = pruneSelection(next, get());
    set((s) => ({ doc: next, future: s.future.slice(1), past: [...s.past, doc].slice(-60), dirty: true, ...sel }));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => get().save(), 600);
  },

  addAsset: (a) => get().mutate((d) => d.assets.push(a)),

  // removeAsset drops an asset and any clips that reference it.
  removeAsset: (assetId) =>
    get().mutate((d) => {
      d.assets = d.assets.filter((a) => a.id !== assetId);
      for (const t of d.tracks) if (t.clips) t.clips = t.clips.filter((c) => c.assetId !== assetId);
    }),

  addClip: (trackId, assetId, start) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const asset = d.assets.find((a) => a.id === assetId);
      if (!t || !asset) return;
      const dur = asset.duration > 0 ? asset.duration : 5;
      const clip: Clip = {
        id: newId("clip_"),
        assetId,
        start,
        in: 0,
        out: dur,
        transform: { x: 0, y: 0, scale: 1, opacity: 1 },
        volume: 1,
      };
      (t.clips ||= []).push(clip);
    }),

  updateClip: (trackId, clipId, patch) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const c = t?.clips?.find((c) => c.id === clipId);
      if (c) Object.assign(c, patch);
    }),

  removeClip: (trackId, clipId) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      if (t?.clips) t.clips = t.clips.filter((c) => c.id !== clipId);
    }),

  // splitAtPlayhead razors the selected clip (or any clip under the playhead) in two.
  splitAtPlayhead: () => {
    const { doc, selClip, playhead } = get();
    if (!doc) return;
    get().mutate((d) => {
      const cut = (t: Track) => {
        if (!t.clips) return;
        const list: Clip[] = [];
        for (const c of t.clips) {
          const sp = c.speed && c.speed > 0 ? c.speed : 1;
          const end = c.start + (c.out - c.in) / sp;
          const isTarget = selClip ? c.id === selClip.clipId : true;
          if (isTarget && playhead > c.start + 0.05 && playhead < end - 0.05) {
            const srcCut = c.in + (playhead - c.start) * sp;
            list.push({ ...c, out: srcCut, fadeOut: 0 });
            list.push({ ...c, id: newId("clip_"), in: srcCut, start: playhead, fadeIn: 0 });
          } else {
            list.push(c);
          }
        }
        t.clips = list;
      };
      if (selClip) {
        const t = d.tracks.find((t) => t.id === selClip.trackId);
        if (t) cut(t);
      } else {
        d.tracks.forEach((t) => t.kind !== "caption" && cut(t));
      }
    });
  },

  deleteSelected: () => {
    const { selClips, selCue } = get();
    if (selClips.length) {
      const ids = new Set(selClips.map((c) => c.clipId));
      get().mutate((d) => {
        for (const t of d.tracks) if (t.clips) t.clips = t.clips.filter((c) => !ids.has(c.id));
      });
      set({ selClip: null, selClips: [] });
    } else if (selCue) {
      get().removeCue(selCue);
    }
  },

  // rippleDelete removes the selection and closes the gaps: on each track, later
  // clips shift left by the total duration of deleted clips that preceded them.
  rippleDelete: () => {
    const { selClips } = get();
    if (!selClips.length) return;
    const ids = new Set(selClips.map((c) => c.clipId));
    get().mutate((d) => {
      for (const t of d.tracks) {
        if (!t.clips) continue;
        const dead = t.clips.filter((c) => ids.has(c.id));
        if (!dead.length) continue;
        t.clips = t.clips.filter((c) => !ids.has(c.id));
        for (const c of t.clips) {
          const shift = dead
            .filter((x) => x.start < c.start)
            .reduce((s, x) => s + clipPlayDur(x), 0);
          c.start = Math.max(0, c.start - shift);
        }
      }
    });
    set({ selClip: null, selClips: [] });
  },

  copySelected: () => {
    const { doc, selClips } = get();
    if (!doc) return;
    clipboard = selClips
      .map((s) => {
        const c = doc.tracks.find((t) => t.id === s.trackId)?.clips?.find((cc) => cc.id === s.clipId);
        return c ? { trackId: s.trackId, clip: structuredClone(c) } : null;
      })
      .filter(Boolean) as { trackId: string; clip: Clip }[];
  },

  // paste inserts the clipboard at the playhead (earliest clip anchored there),
  // keeping relative offsets, on the original tracks, and selects the copies.
  paste: () => {
    const { doc, playhead } = get();
    if (!doc || !clipboard.length) return;
    const earliest = Math.min(...clipboard.map((c) => c.clip.start));
    const delta = playhead - earliest;
    const pasted: { trackId: string; clipId: string }[] = [];
    get().mutate((d) => {
      for (const { trackId, clip } of clipboard) {
        const track = d.tracks.find((t) => t.id === trackId) || d.tracks.find((t) => t.kind === "video");
        if (!track) continue;
        const id = newId("clip_");
        (track.clips ||= []).push({ ...structuredClone(clip), id, start: Math.max(0, clip.start + delta) });
        pasted.push({ trackId: track.id, clipId: id });
      }
    });
    if (pasted.length) set({ selClips: pasted, selClip: pasted[pasted.length - 1], selCue: null });
  },

  nudgePlayhead: (delta) => set((s) => ({ playhead: Math.max(0, s.playhead + delta) })),

  setCues: (cues) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.kind === "caption");
      if (t) t.cues = cues;
    }),

  updateCue: (id, patch) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.kind === "caption");
      const c = t?.cues?.find((c) => c.id === id);
      if (c) Object.assign(c, patch);
    }),

  addCue: () =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.kind === "caption");
      if (!t) return;
      const start = get().playhead;
      (t.cues ||= []).push({
        id: newId("cue_"),
        start,
        end: start + 2,
        text: "New caption",
        style: { font: "Inter", size: 24, color: "#ffffff", align: "center", posY: 0.85 },
      });
    }),

  removeCue: (id) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.kind === "caption");
      if (t?.cues) t.cues = t.cues.filter((c) => c.id !== id);
    }),

  setBackground: (color) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.kind === "background");
      if (t) t.backgroundColor = color;
    }),

  // addTrack inserts a new content lane above the captions lane. Kept between the
  // existing content tracks and captions so lane ordering stays sensible.
  addTrack: (kind) =>
    get().mutate((d) => {
      const label = kind === "audio" ? "Audio" : kind === "overlay" ? "Overlay" : "Video";
      const n = d.tracks.filter((t) => t.kind === kind).length + 1;
      const track: Track = { id: newId("t_"), kind, name: `${label} ${n}`, clips: [] };
      const capIdx = d.tracks.findIndex((t) => t.kind === "caption");
      if (capIdx >= 0) d.tracks.splice(capIdx, 0, track);
      else d.tracks.push(track);
    }),

  removeTrack: (trackId) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      if (!t || t.kind === "background" || t.kind === "caption") return;
      d.tracks = d.tracks.filter((x) => x.id !== trackId);
    }),

  // moveTrack swaps a track with its neighbour (dir -1 = up, +1 = down), but only
  // among reorderable content lanes (background stays first, captions last).
  moveTrack: (trackId, dir) =>
    get().mutate((d) => {
      const i = d.tracks.findIndex((t) => t.id === trackId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= d.tracks.length) return;
      const a = d.tracks[i];
      const b = d.tracks[j];
      const fixed = (t: Track) => t.kind === "background" || t.kind === "caption";
      if (fixed(a) || fixed(b)) return;
      d.tracks[i] = b;
      d.tracks[j] = a;
    }),

  toggleTrackFlag: (trackId, flag) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      if (t) (t as any)[flag] = !(t as any)[flag];
    }),

  // addKeyframe records the clip's current transform value for `prop` at the
  // playhead (clip-local). The Transform field acts as the scratch value being
  // keyed: set it, move the playhead, add another key to build motion.
  addKeyframe: (trackId, clipId, prop) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c) return;
      const tLocal = Math.max(0, +(get().playhead - c.start).toFixed(3));
      const value = c.transform[prop];
      const kf = (c.keyframes ||= {});
      const list = (kf[prop] ||= []);
      const existing = list.findIndex((k) => Math.abs(k.t - tLocal) < 0.02);
      // New keys default to a smooth curve so motion reads designed, not robotic;
      // opacity fades stay linear. Overwriting a key keeps its chosen ease.
      if (existing >= 0) list[existing] = { ...list[existing], t: tLocal, value };
      else list.push({ t: tLocal, value, ease: prop === "opacity" ? "linear" : "easeInOut" });
      list.sort((a, b) => a.t - b.t);
    }),

  updateKeyframe: (trackId, clipId, prop, index, value) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      const k = c?.keyframes?.[prop]?.[index];
      if (k) k.value = value;
    }),

  setKeyframeEase: (trackId, clipId, prop, index, ease) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      const k = c?.keyframes?.[prop]?.[index];
      if (k) k.ease = ease;
    }),

  removeKeyframe: (trackId, clipId, prop, index) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      const list = c?.keyframes?.[prop];
      if (!list) return;
      list.splice(index, 1);
      if (list.length === 0) delete c!.keyframes![prop];
    }),

  updateEffect: (trackId, clipId, key, value) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c) return;
      (c.effects ||= {})[key] = value;
    }),

  resetEffects: (trackId, clipId) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (c) delete c.effects;
    }),

  // addTitle drops a 3s text clip on the first overlay track at the playhead and
  // selects it for editing.
  addTitle: () => {
    const { doc, playhead } = get();
    if (!doc) return;
    const track = doc.tracks.find((t) => t.kind === "overlay") || doc.tracks.find((t) => t.kind === "video");
    if (!track) return;
    const clipId = newId("title_");
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === track.id)!;
      (t.clips ||= []).push({
        id: clipId,
        assetId: "",
        start: Math.max(0, playhead),
        in: 0,
        out: 3,
        transform: { x: 0, y: 0, scale: 1, opacity: 1 },
        volume: 0,
        title: { text: "Your title", size: 96, color: "#ffffff", align: "center", posY: 0.5, bold: true },
      });
    });
    set({ selClip: { trackId: track.id, clipId }, selCue: null });
  },

  updateTitle: (trackId, clipId, patch) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (c?.title) Object.assign(c.title, patch);
    }),

  addMarker: () => {
    const playhead = get().playhead;
    get().mutate((d) => {
      const n = (d.markers?.length ?? 0) + 1;
      (d.markers ||= []).push({ id: newId("mk_"), t: +playhead.toFixed(3), label: `Marker ${n}`, color: "#f4b740" });
      d.markers.sort((a, b) => a.t - b.t);
    });
  },

  removeMarker: (id) =>
    get().mutate((d) => {
      if (d.markers) d.markers = d.markers.filter((m) => m.id !== id);
    }),

  updateMarker: (id, patch) =>
    get().mutate((d) => {
      const m = d.markers?.find((m) => m.id === id);
      if (m) Object.assign(m, patch);
    }),

  select: (trackId, clipId) =>
    set({ selClip: { trackId, clipId }, selClips: [{ trackId, clipId }], selCue: null }),

  toggleSelect: (trackId, clipId) =>
    set((s) => {
      const has = s.selClips.some((c) => c.clipId === clipId);
      const selClips = has
        ? s.selClips.filter((c) => c.clipId !== clipId)
        : [...s.selClips, { trackId, clipId }];
      return {
        selClips,
        selClip: has ? selClips[selClips.length - 1] ?? null : { trackId, clipId },
        selCue: null,
      };
    }),

  batchUpdateClips: (updates) =>
    get().mutate((d) => {
      for (const u of updates) {
        const c = d.tracks.find((t) => t.id === u.trackId)?.clips?.find((c) => c.id === u.clipId);
        if (c) Object.assign(c, u.patch);
      }
    }),

  selectCue: (id) => set({ selCue: id, selClip: null, selClips: [] }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (p) => set({ playing: p }),
  setZoom: (px) => set({ pxPerSec: Math.min(400, Math.max(20, px)) }),
  setSnapLine: (t) => set({ snapLine: t }),
}));

// pruneSelection drops selection entries pointing at clips/cues that no longer
// exist in the target doc (e.g. after an undo/redo that removed them), so the
// Inspector never references a stale id.
function pruneSelection(
  doc: EditDoc,
  cur: { selClip: StudioState["selClip"]; selClips: StudioState["selClips"]; selCue: string | null },
): Partial<StudioState> {
  const clipIds = new Set<string>();
  const cueIds = new Set<string>();
  for (const t of doc.tracks) {
    for (const c of t.clips || []) clipIds.add(c.id);
    for (const q of t.cues || []) cueIds.add(q.id);
  }
  const selClips = cur.selClips.filter((s) => clipIds.has(s.clipId));
  const selClip = cur.selClip && clipIds.has(cur.selClip.clipId) ? cur.selClip : selClips[0] ?? null;
  const selCue = cur.selCue && cueIds.has(cur.selCue) ? cur.selCue : null;
  return { selClips, selClip, selCue };
}

// Duration of the whole project = furthest clip/cue end.
export function projectDuration(doc: EditDoc | null): number {
  if (!doc) return 0;
  let end = 0;
  for (const t of doc.tracks) {
    for (const c of t.clips || []) end = Math.max(end, c.start + clipPlayDur(c));
    for (const q of t.cues || []) end = Math.max(end, q.end);
  }
  return end;
}

export const findTrack = (doc: EditDoc, id: string): Track | undefined =>
  doc.tracks.find((t) => t.id === id);
