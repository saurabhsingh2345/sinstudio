import { useRef, useState } from "react";
import { useStudio } from "../state";
import { api } from "../api";
import { toast } from "../toast";
import { mediaUrl, type Asset } from "../types";
import { GenerateModal } from "./GenerateModal";
import { LibraryModal } from "./LibraryModal";
import { AppsModal } from "./AppsModal";

// Default lane for an asset kind.
const laneFor = (a: Asset) =>
  a.kind === "audio" ? "t_music" : a.kind === "image" ? "t_overlay" : "t_video";

export function AssetPanel({ projectId }: { projectId: string }) {
  const { doc, addAsset, addClip, playhead } = useStudio();
  const fileRef = useRef<HTMLInputElement>(null);
  const [gen, setGen] = useState(false);
  const [genInit, setGenInit] = useState<string | undefined>();
  const [lib, setLib] = useState(false);
  const [appsOpen, setAppsOpen] = useState(false);
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
        Assets
        <div className="spacer" />
        <button onClick={() => setAppsOpen(true)} title="Run & manage your generator apps">
          Apps
        </button>
        <button onClick={() => setLib(true)} title="Clips from your other products">
          Library
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? "…" : "Import"}
        </button>
        <button className="primary" onClick={() => setGen(true)}>
          Generate
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
          Import media or Generate a clip from newaniAdv / HyperFrames.
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
        </div>
      ))}

      {appsOpen && (
        <AppsModal
          onClose={() => setAppsOpen(false)}
          onGenerate={(generatorId) => {
            setAppsOpen(false);
            setGenInit(generatorId);
            setGen(true);
          }}
        />
      )}
      {gen && (
        <GenerateModal
          projectId={projectId}
          initialGenerator={genInit}
          onClose={() => {
            setGen(false);
            setGenInit(undefined);
          }}
          onDone={(asset) => {
            addAsset(asset);
            setGen(false);
            setGenInit(undefined);
          }}
        />
      )}
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
