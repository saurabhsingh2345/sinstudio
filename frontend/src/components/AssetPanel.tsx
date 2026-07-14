import { useRef, useState } from "react";
import { useStudio } from "../state";
import { api } from "../api";
import { toast } from "../toast";
import { mediaUrl, type Asset } from "../types";
import { LibraryModal } from "./LibraryModal";
import { Icon } from "./Icon";

// Default lane for an asset kind.
const laneFor = (a: Asset) =>
  a.kind === "audio" ? "t_music" : a.kind === "image" ? "t_overlay" : "t_video";

export function AssetPanel({ projectId }: { projectId: string }) {
  const { doc, addAsset, addClip, removeAsset, playhead } = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const [lib, setLib] = useState(false);
  const [busy, setBusy] = useState(false);

  const onImport = async (files: FileList | null) => {
    if (!files) return;
    setBusy(true);
    try {
      for (const f of Array.from(files)) {
        const { asset } = await api.importAsset(projectId, f);
        addAsset(asset);
      }
      toast.success("Imported");
    } catch (e) {
      toast.error("Import failed: " + (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel-h">
        Media
        <div className="spacer" />
        <button className="ghost" onClick={() => setLib(true)} title="Browse clips already produced by your apps">
          <Icon name="library" /> Library
        </button>
        <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy} title="Import media files">
          <Icon name="import" /> {busy ? "…" : "Import"}
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          accept="video/*,audio/*,image/*"
          style={{ display: "none" }}
          onChange={(e) => onImport(e.target.files)}
        />
      </div>

      {doc?.assets.length === 0 && (
        <div className="muted" style={{ padding: 12 }}>
          Import media, browse your Library, or generate a clip from the <b>Plugins</b> tab.
        </div>
      )}

      {doc?.assets.map((a) => (
        <div
          key={a.id}
          className="asset"
          draggable
          onDragStart={(e) => e.dataTransfer.setData("text/assetId", a.id)}
          onClick={() => addClip(laneFor(a), a.id, playhead)}
          title="Click to add at playhead · or drag onto a track"
        >
          {a.thumbnail ? (
            <img src={mediaUrl(a.thumbnail)} />
          ) : (
            <div className="noimg" />
          )}
          <div className="meta">
            <div className="nm">{a.name}</div>
            <div className="sub">
              <span className="badge">{a.source}</span> {a.kind} · {a.duration.toFixed(1)}s
              {a.hasAlpha ? " · alpha" : ""}
            </div>
          </div>
          <button
            className="asset-rm"
            title="Remove asset (and its clips)"
            onClick={(e) => {
              e.stopPropagation();
              if (confirm(`Remove "${a.name}" and any clips using it?`)) removeAsset(a.id);
            }}
          >
            ✕
          </button>
        </div>
      ))}

      {lib && (
        <LibraryModal
          projectId={projectId}
          onClose={() => setLib(false)}
          onImported={(asset) => addAsset(asset)}
        />
      )}
    </>
  );
}
