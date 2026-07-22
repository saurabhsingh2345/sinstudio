import { create } from "zustand";
import { api, ConflictError } from "./api";
import type { Annotation, AnnoKind, Asset, CaptionCue, Clip, EditDoc, Keyable, Keyframe, Track, TitleAnim, TitleReveal } from "./types";
import { newId, clipPlayDur } from "./types";
import { buildTitleAnim } from "./titleAnim";
import { newAnnotation } from "./annotation";
import { buildMotionPreset, type MotionPreset } from "./motionPresets";
import { clearPeaks } from "./peaks";
import { cutClipSilences, planSilenceCuts, type SilenceSpan } from "./silence";
import { clearCursorTracks } from "./cursorTracks";

interface StudioState {
  doc: EditDoc | null;
  saving: boolean;
  dirty: boolean;
  // Set when the server rejected a save because someone else got there first.
  // The editor keeps the local doc so nothing is lost until the user chooses.
  conflict: { current: EditDoc } | null;
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
  // Discard local edits and adopt the server's document after a conflict.
  resolveConflict: () => void;

  addAsset: (a: Asset) => void;
  updateAsset: (a: Asset) => void;
  removeAsset: (assetId: string) => void;
  addClip: (trackId: string, assetId: string, start: number) => void;
  addClipToLane: (assetId: string, start?: number) => void;
  addSyncedClips: (
    items: { assetId: string; lane: "video" | "overlay" | "audio"; startedAt: number }[]
  ) => void;
  updateClip: (trackId: string, clipId: string, patch: Partial<Clip>) => void;
  moveClip: (fromTrackId: string, toTrackId: string, clipId: string, start: number) => void;
  removeClip: (trackId: string, clipId: string) => void;
  duplicateClip: (trackId: string, clipId: string) => void;
  reflowTrack: (trackId: string) => void;
  insertAssetOnSpine: (trackId: string, assetId: string, index: number) => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
  rippleDelete: () => void;
  /** Replace a clip with its non-silent segments and pull everything after it left. */
  removeSilences: (trackId: string, clipId: string, silences: SilenceSpan[]) => number;
  copySelected: () => void;
  paste: () => void;
  nudgePlayhead: (delta: number) => void;

  setCues: (cues: CaptionCue[]) => void;
  updateCue: (id: string, patch: Partial<CaptionCue>) => void;
  addCue: () => void;
  removeCue: (id: string) => void;

  setBackground: (color: string) => void;

  detachAudio: (trackId: string, clipId: string) => void;
  attachAudio: (trackId: string, clipId: string) => void;

  addTrack: (kind: "video" | "overlay" | "audio") => void;
  removeTrack: (trackId: string) => void;
  moveTrack: (trackId: string, dir: -1 | 1) => void;
  moveTrackZ: (trackId: string, dir: -1 | 1) => void;
  toggleTrackFlag: (trackId: string, flag: "muted" | "hidden" | "solo" | "duck") => void;

  addKeyframe: (trackId: string, clipId: string, prop: Keyable) => void;
  applyMotionPreset: (trackId: string, clipId: string, preset: MotionPreset) => void;
  updateKeyframe: (trackId: string, clipId: string, prop: string, index: number, value: number) => void;
  moveKeyframe: (trackId: string, clipId: string, prop: string, index: number, t: number) => void;
  setKeyframeEase: (trackId: string, clipId: string, prop: string, index: number, ease: string) => void;
  removeKeyframe: (trackId: string, clipId: string, prop: string, index: number) => void;
  updateEffect: (trackId: string, clipId: string, key: keyof NonNullable<Clip["effects"]>, value: number) => void;
  resetEffects: (trackId: string, clipId: string) => void;
  updateEQ: (trackId: string, clipId: string, band: "low" | "mid" | "high", value: number) => void;
  resetEQ: (trackId: string, clipId: string) => void;
  addTitle: () => void;
  updateTitle: (trackId: string, clipId: string, patch: Partial<NonNullable<Clip["title"]>>) => void;
  applyTitleAnim: (trackId: string, clipId: string, preset: TitleAnim) => void;
  applyTitleReveal: (trackId: string, clipId: string, reveal: TitleReveal) => void;
  addAnnotation: (kind: AnnoKind) => void;
  updateAnnotation: (trackId: string, clipId: string, patch: Partial<Annotation>) => void;

  addMarker: () => void;
  removeMarker: (id: string) => void;
  updateMarker: (id: string, patch: { t?: number; label?: string; color?: string }) => void;

  select: (trackId: string, clipId: string) => void;
  toggleSelect: (trackId: string, clipId: string) => void;
  selectClips: (clips: { trackId: string; clipId: string }[]) => void;
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
// Monotonic count of local edits. Only used to tell whether a transient gesture
// actually changed anything; doc.version can't serve that role now that it is
// the server-assigned revision.
let editSeq = 0;
let snapSeq = 0;

export const useStudio = create<StudioState>((set, get) => ({
  doc: null,
  saving: false,
  dirty: false,
  conflict: null,
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
    clearPeaks(); // drop cached waveforms from any previously-open project
    clearCursorTracks();
    set({ doc, dirty: false, conflict: null, past: [], future: [], selClip: null, selClips: [], selCue: null, playhead: 0 });
  },

  save: async () => {
    const doc = get().doc;
    if (!doc || get().conflict) return; // don't keep retrying into a known conflict
    set({ saving: true });
    try {
      const { version } = await api.saveProject(doc);
      // Adopt the server's revision on the CURRENT doc, not the pre-await
      // snapshot: edits made during the in-flight save must not be clobbered.
      // Only clear the dirty flag if nothing changed while we were saving.
      set((s) => {
        if (!s.doc) return { saving: false };
        const unchanged = s.doc === doc;
        return {
          saving: false,
          dirty: unchanged ? false : s.dirty,
          doc: { ...s.doc, version },
        };
      });
    } catch (e) {
      if (e instanceof ConflictError) {
        // Someone else saved this timeline first. Keep the local doc untouched so
        // no work is lost, and let the UI ask what to do.
        set({ saving: false, conflict: { current: e.current } });
        return;
      }
      set({ saving: false });
      console.error("save failed", e);
    }
  },

  resolveConflict: () => {
    const c = get().conflict;
    if (!c) return;
    clearPeaks();
    clearCursorTracks();
    set({
      doc: c.current,
      conflict: null,
      dirty: false,
      past: [],
      future: [],
      selClip: null,
      selClips: [],
      selCue: null,
    });
  },

  // mutate applies fn to a cloned doc, records history, autosaves. During a
  // transient gesture, history is not touched (beginTransient captured the one
  // snapshot; commitTransient will push it).
  //
  // Note it does NOT touch doc.version: that is the server's revision, sent back
  // as the base for optimistic concurrency. Bumping it locally would make every
  // save look stale and 409 immediately.
  mutate: (fn) => {
    const cur = get().doc;
    if (!cur) return;
    const doc: EditDoc = structuredClone(cur);
    fn(doc);
    editSeq++;
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
    if (d) {
      txnSnapshot = structuredClone(d);
      snapSeq = editSeq;
    }
  },

  commitTransient: () => {
    const snap = txnSnapshot;
    txnSnapshot = null;
    if (!snap) return;
    // Only record history if the gesture actually changed something. This used
    // to compare doc.version, which is now the server's revision and no longer
    // moves on local edits.
    if (get().doc && editSeq !== snapSeq) {
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

  // updateAsset replaces an asset in place (e.g. after a plugin re-render) and
  // repairs clips that reference it: a shorter re-render would leave a clip's
  // out-point past the media end (over-running into black), so clamp in/out into
  // the new duration. Spine (video) tracks then reflow so gaps close.
  updateAsset: (a) =>
    get().mutate((d) => {
      const i = d.assets.findIndex((x) => x.id === a.id);
      if (i === -1) d.assets.push(a);
      else d.assets[i] = a;
      const dur = a.duration > 0 ? a.duration : 0;
      for (const t of d.tracks) {
        if (!t.clips) continue;
        let touched = false;
        for (const c of t.clips) {
          if (c.assetId !== a.id) continue;
          if (dur > 0 && c.out > dur) {
            c.out = +dur.toFixed(3);
            touched = true;
          }
          if (dur > 0 && c.in > dur - 0.1) {
            c.in = +Math.max(0, dur - 0.1).toFixed(3);
            touched = true;
          }
        }
        if (touched && t.kind === "video") reflowClips(t);
      }
    }),

  // removeAsset drops the asset's clips from the timeline (a document edit) AND
  // deletes the asset itself (a separate resource now). Filtering it out of
  // d.assets alone would no longer persist: the server owns the asset set and
  // ignores it in a document save.
  removeAsset: (assetId) => {
    const id = get().doc?.id;
    get().mutate((d) => {
      d.assets = d.assets.filter((a) => a.id !== assetId);
      for (const t of d.tracks) if (t.clips) t.clips = t.clips.filter((c) => c.assetId !== assetId);
    });
    if (id) {
      // Soft delete server-side; the media file is deliberately left on disk.
      api.deleteAsset(id, assetId).catch((e) => console.error("delete asset failed", e));
    }
  },

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

  // addClipToLane drops an asset onto the first lane matching its kind, creating
  // the lane if the project no longer has one. Imports use this instead of
  // hardcoded default track ids, which stop existing once lanes are recreated.
  addClipToLane: (assetId, start) =>
    get().mutate((d) => {
      const asset = d.assets.find((a) => a.id === assetId);
      if (!asset) return;
      const kind = asset.kind === "audio" ? "audio" : asset.kind === "image" ? "overlay" : "video";
      let t = d.tracks.find((t) => t.kind === kind);
      if (!t) {
        const label = kind === "audio" ? "Audio" : kind === "overlay" ? "Overlay" : "Video";
        t = { id: newId("t_"), kind, name: `${label} 1`, clips: [] };
        const capIdx = d.tracks.findIndex((x) => x.kind === "caption");
        if (capIdx >= 0) d.tracks.splice(capIdx, 0, t);
        else d.tracks.push(t);
      }
      const dur = asset.duration > 0 ? asset.duration : 5;
      // Placement default depends on the lane. Video is the spine: append after
      // the last clip so clips lay out sequentially (two 10s clips → 0–10, 10–20
      // = 20s) instead of stacking at 0. Audio/overlay are free-positioned: drop
      // at the playhead so a voiceover lands where you scrubbed (e.g. a freeze-
      // frame point) instead of overlapping the video's audio from the top. A
      // positioned drop passes an explicit start, which always wins.
      const laneEnd = (t.clips ?? []).reduce((m, c) => Math.max(m, c.start + clipPlayDur(c)), 0);
      const at = start ?? (kind === "video" ? laneEnd : Math.max(0, get().playhead));
      (t.clips ||= []).push({
        id: newId("clip_"),
        assetId,
        start: +at.toFixed(3),
        in: 0,
        out: dur,
        transform: { x: 0, y: 0, scale: 1, opacity: 1 },
        volume: 1,
      });
    }),

  // addSyncedClips places several assets that were captured together so they
  // stay in sync. Unlike addClipToLane it never appends to the end of a lane —
  // a screen recording and its narration have to start at the same instant, and
  // "after the last clip" would slide them apart. Each source's own start time
  // preserves the few ms the recorders drifted from each other at launch.
  addSyncedClips: (items) =>
    get().mutate((d) => {
      const present = items.filter((i) => d.assets.some((a) => a.id === i.assetId));
      if (!present.length) return;
      const origin = Math.min(...present.map((i) => i.startedAt));
      const at = Math.max(0, get().playhead);
      for (const item of present) {
        const asset = d.assets.find((a) => a.id === item.assetId)!;
        let t = d.tracks.find((t) => t.kind === item.lane);
        if (!t) {
          const label = item.lane === "audio" ? "Audio" : item.lane === "overlay" ? "Overlay" : "Video";
          t = { id: newId("t_"), kind: item.lane, name: `${label} 1`, clips: [] };
          const capIdx = d.tracks.findIndex((x) => x.kind === "caption");
          if (capIdx >= 0) d.tracks.splice(capIdx, 0, t);
          else d.tracks.push(t);
        }
        const dur = asset.duration > 0 ? asset.duration : 5;
        (t.clips ||= []).push({
          id: newId("clip_"),
          assetId: item.assetId,
          start: +(at + (item.startedAt - origin) / 1000).toFixed(3),
          in: 0,
          out: dur,
          transform: { x: 0, y: 0, scale: 1, opacity: 1 },
          volume: 1,
        });
      }
    }),

  updateClip: (trackId, clipId, patch) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const c = t?.clips?.find((c) => c.id === clipId);
      if (c) Object.assign(c, patch);
    }),

  // moveClip repositions a clip in time, optionally relocating it to another
  // track (same clip object, preserving its id/keyframes/effects). Used by the
  // timeline's drag gesture — horizontal drag sets start; vertical drag across
  // same-kind lanes hands the clip to another track. No reflow: the timeline is
  // free-positioned (gaps allowed), so nothing else shifts.
  moveClip: (fromTrackId, toTrackId, clipId, start) =>
    get().mutate((d) => {
      const from = d.tracks.find((t) => t.id === fromTrackId);
      const c = from?.clips?.find((c) => c.id === clipId);
      if (!from || !c) return;
      const s = +Math.max(0, start).toFixed(3);
      if (fromTrackId === toTrackId) {
        c.start = s;
        return;
      }
      const to = d.tracks.find((t) => t.id === toTrackId);
      if (!to) return;
      from.clips = from.clips!.filter((x) => x.id !== clipId);
      c.start = s;
      (to.clips ||= []).push(c);
    }),

  removeClip: (trackId, clipId) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      if (!t?.clips) return;
      const removed = t.clips.filter((c) => c.id === clipId);
      if (!removed.length) return;
      t.clips = t.clips.filter((c) => c.id !== clipId);
      // A video track is a contiguous spine: closing the gap shortens the
      // timeline instead of leaving a hole that reads as a frozen frame during
      // playback. Overlay/audio clips stay free-positioned.
      if (t.kind === "video") reflowClips(t);
      unmuteOrphanedSources(d, removed);
    }),

  // duplicateClip ripple-inserts a copy right after the original: later clips on
  // the track shift by the copy's duration so nothing overlaps.
  duplicateClip: (trackId, clipId) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const c = t?.clips?.find((c) => c.id === clipId);
      if (!t || !c) return;
      const copy = structuredClone(c);
      copy.id = newId("clip_");
      const dur = clipPlayDur(c);
      const end = c.start + dur;
      // The original's detached-audio clip isn't cloned, so if that's why it is
      // muted, the copy should play its own embedded audio.
      const hasDetached = d.tracks.some((x) => x.clips?.some((ac) => ac.sourceClip === clipId));
      if (hasDetached) copy.mute = false;
      for (const x of t.clips!) if (x.id !== c.id && x.start >= end - 1e-6) x.start = +(x.start + dur).toFixed(3);
      copy.start = +end.toFixed(3);
      t.clips!.push(copy);
    }),

  // reflowTrack packs a track's clips back-to-back from 0 in start order — the
  // spine's contiguity invariant, re-established after a trim changes durations.
  reflowTrack: (trackId) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      if (t) reflowClips(t);
    }),

  // insertAssetOnSpine ripple-inserts an asset as a clip at a spine position
  // (index in start order); later clips shift right by its duration.
  insertAssetOnSpine: (trackId, assetId, index) =>
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const asset = d.assets.find((a) => a.id === assetId);
      if (!t || !asset) return;
      const dur = asset.duration > 0 ? asset.duration : 5;
      const sorted = [...(t.clips ?? [])].sort((a, b) => a.start - b.start);
      const prev = sorted[Math.min(index, sorted.length) - 1];
      const at = prev ? prev.start + clipPlayDur(prev) : 0;
      for (const c of t.clips ?? []) if (c.start >= at - 1e-6) c.start = +(c.start + dur).toFixed(3);
      (t.clips ||= []).push({
        id: newId("clip_"),
        assetId,
        start: +at.toFixed(3),
        in: 0,
        out: dur,
        transform: { x: 0, y: 0, scale: 1, opacity: 1 },
        volume: 1,
      });
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
            // Keyframes are clip-local (from Start); the right half starts at the
            // playhead, so shift its keyframe times by the split offset and drop any
            // that fall before the new start. Also clear the transition that no
            // longer sits at a clip boundary (left's end / right's start).
            const off = playhead - c.start;
            const rightKf: Record<string, Keyframe[]> = {};
            for (const [prop, pts] of Object.entries(c.keyframes ?? {})) {
              const shifted = pts
                .map((p) => ({ ...p, t: +(p.t - off).toFixed(4) }))
                .filter((p) => p.t >= -1e-6);
              if (shifted.length) rightKf[prop] = shifted;
            }
            list.push({ ...c, out: srcCut, fadeOut: 0, transitionOut: undefined });
            list.push({
              ...c,
              id: newId("clip_"),
              in: srcCut,
              start: playhead,
              fadeIn: 0,
              transitionIn: undefined,
              keyframes: Object.keys(rightKf).length ? rightKf : undefined,
            });
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
        const removed: Clip[] = [];
        for (const t of d.tracks)
          if (t.clips) {
            const dead = t.clips.filter((c) => ids.has(c.id));
            if (!dead.length) continue;
            removed.push(...dead);
            t.clips = t.clips.filter((c) => !ids.has(c.id));
            // Spine tracks close the gap so the project duration shrinks (see removeClip).
            if (t.kind === "video") reflowClips(t);
          }
        unmuteOrphanedSources(d, removed);
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
      const removed: Clip[] = [];
      for (const t of d.tracks) {
        if (!t.clips) continue;
        const dead = t.clips.filter((c) => ids.has(c.id));
        if (!dead.length) continue;
        removed.push(...dead);
        t.clips = t.clips.filter((c) => !ids.has(c.id));
        for (const c of t.clips) {
          const shift = dead
            .filter((x) => x.start < c.start)
            .reduce((s, x) => s + clipPlayDur(x), 0);
          c.start = Math.max(0, c.start - shift);
        }
      }
      unmuteOrphanedSources(d, removed);
    });
    set({ selClip: null, selClips: [] });
  },

  /*
   * The jump-cut pass, as ONE mutate — one undo brings the whole take back.
   * The clip becomes its kept segments back to back, and everything after it
   * on the same track ripples left by the time removed, so the cut tightens
   * the timeline instead of leaving a hole where each pause was.
   */
  removeSilences: (trackId, clipId, silences) => {
    const { doc } = get();
    if (!doc) return 0;
    const track = doc.tracks.find((t) => t.id === trackId);
    const clip = track?.clips?.find((c) => c.id === clipId);
    if (!track || !clip) return 0;
    const plan = planSilenceCuts(clip, silences);
    if (!plan) return 0;
    const clipEnd = clip.start + clipPlayDur(clip);
    get().mutate((d) => {
      const t = d.tracks.find((t) => t.id === trackId);
      const c = t?.clips?.find((c) => c.id === clipId);
      if (!t || !t.clips || !c) return;
      const segments = cutClipSilences(c, plan, () => newId("clip_"));
      const idx = t.clips.findIndex((x) => x.id === clipId);
      t.clips.splice(idx, 1, ...segments);
      for (const other of t.clips) {
        if (segments.includes(other)) continue;
        if (other.start >= clipEnd - 1e-6) other.start = +(other.start - plan.removed).toFixed(4);
      }
    });
    return plan.removed;
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

  // detachAudio splits a video clip's audio into an independent clip on a dedicated
  // "Dialogue" audio track (so it can be volumed/EQ'd/deleted separately), and mutes
  // the source clip's own audio so the export doesn't double it.
  detachAudio: (trackId, clipId) =>
    get().mutate((d) => {
      const vt = d.tracks.find((t) => t.id === trackId);
      const c = vt?.clips?.find((c) => c.id === clipId);
      if (!c || c.title || c.annotation) return; // assetless clips carry no audio
      for (const t of d.tracks)
        if (t.kind === "audio")
          for (const ac of t.clips || []) if (ac.sourceClip === clipId) return; // already detached
      let at = d.tracks.find((t) => t.kind === "audio" && t.name === "Dialogue");
      if (!at) {
        at = { id: newId("t_"), kind: "audio", name: "Dialogue", clips: [] };
        const capIdx = d.tracks.findIndex((t) => t.kind === "caption");
        if (capIdx >= 0) d.tracks.splice(capIdx, 0, at);
        else d.tracks.push(at);
      }
      (at.clips ||= []).push({
        id: newId("aud_"),
        assetId: c.assetId,
        start: c.start,
        in: c.in,
        out: c.out,
        transform: { x: 0, y: 0, scale: 1, opacity: 1 },
        volume: c.volume && c.volume > 0 ? c.volume : 1,
        speed: c.speed,
        fadeIn: c.fadeIn,
        fadeOut: c.fadeOut,
        eq: c.eq ? { ...c.eq } : undefined,
        sourceClip: clipId,
      });
      c.mute = true;
    }),

  // attachAudio re-embeds: removes the detached audio clip(s) for a video clip and
  // un-mutes it, pruning the Dialogue track if it becomes empty.
  attachAudio: (trackId, clipId) =>
    get().mutate((d) => {
      for (const t of d.tracks)
        if (t.kind === "audio" && t.clips) t.clips = t.clips.filter((ac) => ac.sourceClip !== clipId);
      d.tracks = d.tracks.filter(
        (t) => !(t.kind === "audio" && t.name === "Dialogue" && (!t.clips || t.clips.length === 0))
      );
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (c) c.mute = false;
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

  // moveTrackZ changes a track's stacking order among tracks of the SAME kind
  // (+1 = closer to the front). Both the preview and the exporter stack
  // same-kind tracks by array position, and the kind rank (background < video
  // < overlay) pins the groups — swapping across kinds would be a no-op
  // visually, so we hop to the nearest same-kind neighbour instead.
  moveTrackZ: (trackId, dir) =>
    get().mutate((d) => {
      const i = d.tracks.findIndex((t) => t.id === trackId);
      if (i < 0) return;
      const kind = d.tracks[i]!.kind;
      if (kind === "background" || kind === "caption") return;
      let j = i + dir;
      while (j >= 0 && j < d.tracks.length && d.tracks[j]!.kind !== kind) j += dir;
      if (j < 0 || j >= d.tracks.length) return;
      const a = d.tracks[i]!;
      d.tracks[i] = d.tracks[j]!;
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
      // rotation is optional on Transform; an absent one keys as 0°.
      const value = c.transform[prop] ?? 0;
      const kf = (c.keyframes ||= {});
      const list = (kf[prop] ||= []);
      const existing = list.findIndex((k) => Math.abs(k.t - tLocal) < 0.02);
      // New keys default to a smooth curve so motion reads designed, not robotic;
      // opacity fades stay linear. Overwriting a key keeps its chosen ease.
      if (existing >= 0) list[existing] = { ...list[existing], t: tLocal, value };
      else list.push({ t: tLocal, value, ease: prop === "opacity" ? "linear" : "easeInOut" });
      list.sort((a, b) => a.t - b.t);
    }),

  // applyMotionPreset writes a camera move onto a clip. It replaces only the
  // properties the preset animates, so a hand-built opacity fade survives a
  // later "Ken Burns" — and re-applying a preset is idempotent rather than
  // additive.
  applyMotionPreset: (trackId, clipId, preset) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c) return;
      const kf = buildMotionPreset(preset, clipPlayDur(c), d.canvas.width, d.canvas.height);
      const merged = { ...(c.keyframes ?? {}), ...kf };
      c.keyframes = Object.keys(merged).length ? merged : undefined;
    }),

  updateKeyframe: (trackId, clipId, prop, index, value) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      const k = c?.keyframes?.[prop]?.[index];
      if (k) k.value = value;
    }),

  // moveKeyframe retimes a keyframe (clip-local seconds, clamped ≥0) and re-sorts
  // the property's points so interpolation stays ordered. Used by dragging a
  // keyframe diamond on the timeline.
  moveKeyframe: (trackId, clipId, prop, index, t) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      const list = c?.keyframes?.[prop];
      const k = list?.[index];
      if (!list || !k) return;
      k.t = +Math.max(0, t).toFixed(3);
      list.sort((a, b) => a.t - b.t);
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

  updateEQ: (trackId, clipId, band, value) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c) return;
      const eq = { ...(c.eq || {}), [band]: value };
      // Drop the whole EQ once every band is back to flat, to keep the doc clean.
      if (!eq.low && !eq.mid && !eq.high) delete c.eq;
      else c.eq = eq;
    }),

  resetEQ: (trackId, clipId) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (c) delete c.eq;
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

  // addAnnotation drops a callout on the overlay lane at the playhead. Callouts
  // live above the footage they point at, so the overlay track is the right
  // home; falling back to video keeps it working on a project without one.
  addAnnotation: (kind) => {
    const { doc, playhead } = get();
    if (!doc) return;
    const track = doc.tracks.find((t) => t.kind === "overlay") || doc.tracks.find((t) => t.kind === "video");
    if (!track) return;
    const clipId = newId("anno_");
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
        annotation: newAnnotation(kind),
      });
    });
    set({ selClip: { trackId: track.id, clipId }, selCue: null });
  },

  updateAnnotation: (trackId, clipId, patch) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (c?.annotation) Object.assign(c.annotation, patch);
    }),

  // applyTitleAnim writes an animation preset's keyframes/transitions onto a
  // title clip (replacing any prior motion), scaled to the clip's play duration.
  applyTitleAnim: (trackId, clipId, preset) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c?.title) return;
      const { keyframes, transitionIn, transitionOut } = buildTitleAnim(preset, clipPlayDur(c));
      c.keyframes = Object.keys(keyframes).length ? keyframes : undefined;
      c.transitionIn = transitionIn;
      c.transitionOut = transitionOut;
      c.title.anim = preset;
      if (preset !== "none") c.title.reveal = ""; // reveal & transform presets are mutually exclusive
    }),

  // applyTitleReveal toggles a text build-on. It's mutually exclusive with the
  // transform presets (the renderer ignores keyframes during a reveal), so
  // enabling one clears the other's motion to keep preview and export in sync.
  applyTitleReveal: (trackId, clipId, reveal) =>
    get().mutate((d) => {
      const c = d.tracks.find((t) => t.id === trackId)?.clips?.find((c) => c.id === clipId);
      if (!c?.title) return;
      c.title.reveal = reveal;
      if (reveal) {
        c.keyframes = undefined;
        c.transitionIn = undefined;
        c.transitionOut = undefined;
        c.title.anim = "none";
      }
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

  // selectClips replaces the whole selection at once (marquee/box select).
  selectClips: (clips) => set({ selClips: clips, selClip: clips[clips.length - 1] ?? null, selCue: null }),

  selectCue: (id) => set({ selCue: id, selClip: null, selClips: [] }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (p) => set({ playing: p }),
  setZoom: (px) => set({ pxPerSec: Math.min(400, Math.max(4, px)) }),
  setSnapLine: (t) => set({ snapLine: t }),
}));

// unmuteOrphanedSources restores audio on video clips whose detached-audio clip
// was just deleted. detachAudio mutes the source so the export doesn't double
// its audio; deleting the detached clip by any path other than attachAudio
// would otherwise leave the video permanently (and mysteriously) silent.
// reflowClips packs a track's clips back-to-back from 0 in start order — the
// spine's contiguity invariant. Used after a delete/trim so gaps close and the
// project duration (furthest clip end) shrinks instead of leaving a dead hole.
function reflowClips(t: Track) {
  if (!t.clips) return;
  const order = [...t.clips].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const c of order) {
    c.start = +cursor.toFixed(3);
    cursor += clipPlayDur(c);
  }
}

function unmuteOrphanedSources(d: EditDoc, removed: Clip[]) {
  for (const r of removed) {
    if (!r.sourceClip) continue;
    for (const t of d.tracks) {
      const src = t.clips?.find((c) => c.id === r.sourceClip);
      if (src) src.mute = false;
    }
  }
}

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
