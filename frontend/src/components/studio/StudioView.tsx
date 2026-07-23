import { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";

import { useArcTheme } from "../arc/theme";
import { useStudio, projectDuration } from "../../state";
import { toast } from "../../toast";
import { TopBar } from "./TopBar";
import { LeftRail } from "./LeftRail";
import { CenterColumn } from "./CenterColumn";
import { Inspector } from "./InspectorPanel";
import { ReviewModePanel } from "./ReviewModePanel";
import type { PostRecordSummary } from "./PostRecordChecklist";
import type { Selection } from "./selection";
import { findClip } from "./selection";
import { ExportDialog } from "../ExportDialog";
import { RendersModal } from "../RendersModal";
import { aspectOf, captionTrack, cueForClip } from "./bridge";

// ───────────────────────────── Studio root ────────────────────────────────

export function StudioView({ projectId, onHome }: { projectId: string; onHome?: () => void }) {
  const doc = useStudio((s) => s.doc);
  const load = useStudio((s) => s.load);
  const playing = useStudio((s) => s.playing);
  const setPlaying = useStudio((s) => s.setPlaying);
  const setPlayhead = useStudio((s) => s.setPlayhead);

  const [selection, setSelection] = useState<Selection>({ kind: "none" });
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showExport, setShowExport] = useState(false);
  const [showRenders, setShowRenders] = useState(false);
  const [reviewSummary, setReviewSummary] = useState<PostRecordSummary | null>(null);

  // Shared with the Arc dashboard/wizard (localStorage `arc-theme`) so the whole
  // app stays on one theme. `dark` keeps the original editor palette; `light`
  // resolves the `.studio-light` tokens in tailwind.css.
  const [theme, toggleTheme] = useArcTheme();
  const themeClass = theme === "dark" ? "dark" : "studio-light";

  useEffect(() => {
    load(projectId).catch((e) => toast.error(String(e?.message || e)));
  }, [projectId, load]);

  const total = useMemo(() => projectDuration(doc), [doc]);

  // Playback clock — advance the playhead while playing, stop at the end.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const next = useStudio.getState().playhead + dt;
      if (next >= total) {
        setPlayhead(total);
        setPlaying(false);
        return;
      }
      setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total, setPlayhead, setPlaying]);

  // Keyboard shortcuts (ignored while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      const st = useStudio.getState();
      const sel = selectionRef.current;
      const docNow = st.doc;
      const meta = e.metaKey || e.ctrlKey;
      const k = e.key.toLowerCase();
      if (meta && k === "z") { e.preventDefault(); e.shiftKey ? st.redo() : st.undo(); return; }
      if (meta && k === "y") { e.preventDefault(); st.redo(); return; }
      if (meta && k === "c") { st.copySelected(); return; }
      if (meta && k === "v") { st.paste(); return; }
      if (meta) return;
      if (e.code === "Space") { e.preventDefault(); st.setPlaying(!st.playing); return; }
      if (k === "s") { e.preventDefault(); st.splitAtPlayhead(); return; }
      if (k === "m") {
        e.preventDefault();
        const id = st.addMarker();
        if (id) {
          setSelection({ kind: "marker", markerId: id });
          st.selectCue(null);
        }
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        if (sel.kind === "marker") {
          e.preventDefault();
          st.removeMarker(sel.markerId);
          setSelection({ kind: "none" });
          st.selectCue(null);
          return;
        }
        e.preventDefault();
        e.shiftKey ? st.rippleDelete() : st.deleteSelected();
        return;
      }
      if (k === "[" || k === "]") {
        const markers = [...(docNow?.markers ?? [])].sort((a, b) => a.t - b.t);
        if (!markers.length) return;
        e.preventDefault();
        const t = st.playhead;
        let pick: (typeof markers)[number] | undefined;
        if (k === "[") {
          for (let i = markers.length - 1; i >= 0; i--) {
            if (markers[i]!.t < t - 0.001) { pick = markers[i]; break; }
          }
        } else {
          pick = markers.find((m) => m.t > t + 0.001);
        }
        if (!pick) return;
        st.setPlayhead(pick.t);
        setSelection({ kind: "marker", markerId: pick.id });
        st.selectCue(null);
        return;
      }
      if (e.key === "ArrowLeft") { e.preventDefault(); st.nudgePlayhead(e.shiftKey ? -1 : -1 / 30); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); st.nudgePlayhead(e.shiftKey ? 1 : 1 / 30); return; }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Keep the local selection valid as the doc changes; sync it to the store so
  // split/delete/keyboard actions target the same clip the Inspector shows.
  const syncStore = (s: Selection) => {
    const st = useStudio.getState();
    if (s.kind === "clip" || s.kind === "overlay") st.select(s.trackId, s.clipId);
    else if (s.kind === "lane" && s.lane !== "subtitle") st.select(s.trackId, s.clipId);
    else if (s.kind === "lane" && s.lane === "subtitle") {
      const cap = doc ? captionTrack(doc) : undefined;
      const clip = findClip(doc, s.trackId, s.clipId);
      const cue = clip ? cueForClip(cap?.cues, clip) : undefined;
      if (cue) st.selectCue(cue.id);
      else st.select(s.trackId, s.clipId);
    } else if (s.kind === "cue") st.selectCue(s.cueId);
    else st.selectCue(null);
  };
  const select = (s: Selection) => {
    setSelection(s);
    syncStore(s);
  };

  // Actions that CREATE a clip (addTitle, addAnnotation) select it in the store,
  // but the inspector's selection is local — so adopt the store's pick whenever
  // it names a clip we aren't already showing. Without this a callout you just
  // added lands on the timeline with the Project panel still open, and the very
  // next thing you want to do (place it) starts with hunting for it.
  //
  // Matching on clipId alone is deliberate: selecting a lane or overlay syncs
  // the same clip into the store, and those must not be rewritten to kind:"clip".
  const storeSelClip = useStudio((s) => s.selClip);
  useEffect(() => {
    if (!storeSelClip) return;
    if ("clipId" in selection && selection.clipId === storeSelClip.clipId) return;
    setSelection({ kind: "clip", trackId: storeSelClip.trackId, clipId: storeSelClip.clipId });
    // selection is intentionally not a dependency: this reacts to the store
    // making a choice, not to the local selection changing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeSelClip]);

  // Drop inspector selection when the underlying item was removed (undo, ripple cut, etc.).
  useEffect(() => {
    if (!doc) return;
    setSelection((sel) => {
      if (sel.kind === "marker") {
        return doc.markers?.some((m) => m.id === sel.markerId) ? sel : { kind: "none" };
      }
      if (sel.kind === "cue") {
        return captionTrack(doc)?.cues?.some((c) => c.id === sel.cueId) ? sel : { kind: "none" };
      }
      if ("clipId" in sel) {
        return findClip(doc, sel.trackId, sel.clipId) ? sel : { kind: "none" };
      }
      return sel;
    });
  }, [doc]);

  if (!doc) {
    return (
      <div className={`${themeClass} grid h-screen w-screen place-items-center bg-background text-muted-foreground`}>
        <div className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4 animate-pulse text-brand" /> Loading project…
        </div>
      </div>
    );
  }

  const aspect = aspectOf(doc.canvas);

  return (
    <div className={`${themeClass} flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground`}>
      <TopBar
        doc={doc}
        aspect={aspect}
        theme={theme}
        onToggleTheme={toggleTheme}
        onHome={onHome}
        onExport={() => setShowExport(true)}
        onRenders={() => setShowRenders(true)}
      />
      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr_320px]">
        <LeftRail
          projectId={projectId}
          doc={doc}
          onSelect={select}
          onExport={() => setShowExport(true)}
          onEnterReview={(summary) => {
            setReviewSummary(summary);
            if (summary.primaryScreen) {
              select({
                kind: "clip",
                trackId: summary.primaryScreen.trackId,
                clipId: summary.primaryScreen.clipId,
              });
            }
          }}
        />
        <CenterColumn
          doc={doc}
          aspect={aspect}
          selection={selection}
          expanded={expanded}
          onToggleExpand={(id) => setExpanded((e) => ({ ...e, [id]: !e[id] }))}
          onSelect={select}
          total={total}
          reviewMode={!!reviewSummary}
        />
        {reviewSummary ? (
          <ReviewModePanel
            summary={reviewSummary}
            onExit={() => setReviewSummary(null)}
            onExport={() => setShowExport(true)}
          />
        ) : (
          <Inspector doc={doc} selection={selection} onSelect={select} />
        )}
      </div>

      {showExport && <ExportDialog projectId={projectId} onClose={() => setShowExport(false)} />}
      {showRenders && <RendersModal projectId={projectId} onClose={() => setShowRenders(false)} />}
    </div>
  );
}
