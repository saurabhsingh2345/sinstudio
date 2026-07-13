import { useEffect, useState } from "react";
import { useStudio } from "../state";
import { AssetPanel } from "./AssetPanel";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { Transcript } from "./Transcript";
import { ExportDialog } from "./ExportDialog";
import { RendersModal } from "./RendersModal";

export function Editor({ projectId, onHome }: { projectId: string; onHome: () => void }) {
  const {
    doc,
    saving,
    dirty,
    load,
    playing,
    setPlaying,
    splitAtPlayhead,
    deleteSelected,
    rippleDelete,
    copySelected,
    paste,
    nudgePlayhead,
    undo,
    redo,
  } = useStudio();
  const [showExport, setShowExport] = useState(false);
  const [showRenders, setShowRenders] = useState(false);

  useEffect(() => {
    load(projectId).catch(console.error);
  }, [projectId]);

  // keyboard shortcuts (ignored while typing in inputs)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        copySelected();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        paste();
        return;
      }
      switch (e.key) {
        case " ":
          e.preventDefault();
          setPlaying(!playing);
          break;
        case "s":
        case "S":
          splitAtPlayhead();
          break;
        case "Delete":
        case "Backspace":
          e.shiftKey ? rippleDelete() : deleteSelected();
          break;
        case "ArrowLeft":
          nudgePlayhead(e.shiftKey ? -1 : -1 / 30);
          break;
        case "ArrowRight":
          nudgePlayhead(e.shiftKey ? 1 : 1 / 30);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playing]);

  if (!doc) return <div style={{ padding: 40 }}>Loading…</div>;

  return (
    <div className="app">
      <div className="topbar">
        <button onClick={onHome}>← Projects</button>
        <span className="title">{doc.name}</span>
        <span className="status">
          {saving ? "saving…" : dirty ? "unsaved" : "saved"} · v{doc.version}
        </span>
        <div className="spacer" />
        <button onClick={undo} title="Undo (⌘Z)">
          ↶
        </button>
        <button onClick={redo} title="Redo (⌘⇧Z)">
          ↷
        </button>
        <span className="status">
          {doc.canvas.width}×{doc.canvas.height} · {doc.canvas.fps}fps
        </span>
        <button onClick={() => setShowRenders(true)} title="Render queue & history">
          Renders
        </button>
        <button className="primary" onClick={() => setShowExport(true)}>
          Export
        </button>
      </div>

      <div className="editor">
        <div className="col">
          <AssetPanel projectId={projectId} />
        </div>

        <div className="col center">
          <Preview />
          <Timeline />
        </div>

        <div className="col">
          <Inspector />
          <Transcript projectId={projectId} />
        </div>
      </div>

      {showExport && <ExportDialog projectId={projectId} onClose={() => setShowExport(false)} />}
      {showRenders && <RendersModal projectId={projectId} onClose={() => setShowRenders(false)} />}
    </div>
  );
}
