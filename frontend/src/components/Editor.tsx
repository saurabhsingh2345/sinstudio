import { useEffect, useState } from "react";
import { useStudio } from "../state";
import { AssetPanel } from "./AssetPanel";
import { PluginsPanel } from "./PluginsPanel";
import { Preview } from "./Preview";
import { Timeline } from "./Timeline";
import { Inspector } from "./Inspector";
import { Transcript } from "./Transcript";
import { ExportDialog } from "./ExportDialog";
import { RendersModal } from "./RendersModal";
import { Icon } from "./Icon";

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
  const [leftTab, setLeftTab] = useState<"media" | "plugins">("media");

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
        <button className="ghost icon-btn" onClick={onHome} title="Back to projects">
          <Icon name="back" />
        </button>
        <div className="brand">
          <span className="brand-mark" />
          <span className="title">{doc.name}</span>
        </div>
        <span className={"status-pill " + (saving ? "saving" : dirty ? "dirty" : "saved")}>
          <i className="dot" />
          {saving ? "Saving…" : dirty ? "Unsaved" : "Saved"} · v{doc.version}
        </span>
        <div className="spacer" />
        <div className="seg">
          <button className="icon-btn" onClick={undo} title="Undo (⌘Z)">
            <Icon name="undo" />
          </button>
          <button className="icon-btn" onClick={redo} title="Redo (⌘⇧Z)">
            <Icon name="redo" />
          </button>
        </div>
        <span className="chip">
          {doc.canvas.width}×{doc.canvas.height} · {doc.canvas.fps}fps
        </span>
        <button className="ghost" onClick={() => setShowRenders(true)} title="Render queue & history">
          <Icon name="renders" /> Renders
        </button>
        <button className="primary" onClick={() => setShowExport(true)}>
          <Icon name="export" /> Export
        </button>
      </div>

      <div className="editor">
        <div className="col leftcol">
          <div className="dock-tabs">
            <button className={leftTab === "media" ? "on" : ""} onClick={() => setLeftTab("media")}>
              <Icon name="library" /> Media
            </button>
            <button className={leftTab === "plugins" ? "on" : ""} onClick={() => setLeftTab("plugins")}>
              <Icon name="apps" /> Plugins
            </button>
          </div>
          <div className="dock-body">
            {leftTab === "media" ? (
              <AssetPanel projectId={projectId} />
            ) : (
              <PluginsPanel projectId={projectId} />
            )}
          </div>
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
