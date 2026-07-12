import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { Asset, LibraryEntry, LibrarySource } from "../types";

// Pull clips already produced by the sibling products (newaniAdv, HyperFrames,
// Codigo, funkycode) and the ingest inbox into this project.
export function LibraryModal({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: (a: Asset) => void;
}) {
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState("");

  const refresh = () => {
    setLoading(true);
    api
      .library()
      .then((d) => {
        setSources(d.sources);
        setEntries(d.entries);
      })
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  const shown = useMemo(
    () => (filter === "all" ? entries : entries.filter((e) => e.source === filter)),
    [entries, filter]
  );

  const importOne = async (e: LibraryEntry) => {
    setImporting(e.id);
    try {
      const { asset } = await api.importFromLibrary(projectId, e.path, e.name);
      onImported(asset);
      toast.success("Imported " + e.name);
    } catch (err) {
      toast.error("Import failed: " + (err as Error).message);
    } finally {
      setImporting("");
    }
  };

  const srcName = (id: string) => sources.find((s) => s.id === id)?.name || id;

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>Library — clips from your products</h3>
          <div style={{ flex: 1 }} />
          <button onClick={refresh}>↻ Rescan</button>
        </div>

        <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="all">All sources ({entries.length})</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({entries.filter((e) => e.source === s.id).length})
              </option>
            ))}
          </select>
        </div>

        <div style={{ marginTop: 10, maxHeight: "52vh", overflow: "auto" }}>
          {loading && <div className="muted">Scanning…</div>}
          {!loading && shown.length === 0 && <div className="muted">No clips found.</div>}
          {shown.map((e) => (
            <div key={e.id} className="asset" style={{ cursor: "default" }}>
              <div className="noimg" style={{ display: "grid", placeItems: "center", fontSize: 9 }}>
                {e.ext.replace(".", "").toUpperCase()}
              </div>
              <div className="meta" style={{ flex: 1 }}>
                <div className="nm">{e.name}</div>
                <div className="sub">
                  <span className="badge">{srcName(e.source)}</span>{" "}
                  {(e.size / 1e6).toFixed(1)} MB · {e.modTime.replace("T", " ").replace("Z", "")}
                </div>
              </div>
              <button
                className="primary"
                style={{ flex: "0 0 auto" }}
                disabled={importing === e.id}
                onClick={() => importOne(e)}
              >
                {importing === e.id ? "…" : "Add"}
              </button>
            </div>
          ))}
        </div>

        <div className="row" style={{ marginTop: 12, justifyContent: "flex-end" }}>
          <button style={{ flex: "0 0 auto" }} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
