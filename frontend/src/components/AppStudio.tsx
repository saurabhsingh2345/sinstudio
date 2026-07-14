import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { toast } from "../toast";
import type { AppStatus, LibraryEntry } from "../types";
import { Icon } from "./Icon";

// AppStudio embeds a sibling app's own browser UI inside Studio (an iframe onto
// its dev server) and watches its output folder: clips you create in the app
// appear in the side strip and import in one click (or automatically). This is
// the "use them as they are" path — no JSON, author natively.
export function AppStudio({
  app,
  sources,
  onClose,
  onImport,
}: {
  app: AppStatus;
  sources: string[];
  onClose: () => void;
  onImport: (e: LibraryEntry, toTimeline: boolean) => Promise<unknown>;
}) {
  const [clips, setClips] = useState<LibraryEntry[]>([]);
  const [healthy, setHealthy] = useState(app.state === "running" && app.healthy);
  const [autoImport, setAutoImport] = useState(false);
  const [importing, setImporting] = useState("");
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const baseline = useRef<Set<string> | null>(null); // clip ids that existed when we opened
  const known = useRef<Set<string>>(new Set());
  const autoRef = useRef(autoImport);
  autoRef.current = autoImport;

  const doImport = async (e: LibraryEntry) => {
    setImporting(e.id);
    try {
      await onImport(e, true);
      setImportedIds((s) => new Set(s).add(e.id));
    } catch (err) {
      toast.error("Import failed: " + (err as Error).message);
    } finally {
      setImporting("");
    }
  };

  // Watch the app's output folder for new clips.
  useEffect(() => {
    let alive = true;
    const scan = async () => {
      try {
        const d = await api.library();
        const mine = d.entries
          .filter((e) => sources.includes(e.source))
          .sort((a, b) => (a.modTime < b.modTime ? 1 : -1));
        if (baseline.current === null) {
          baseline.current = new Set(mine.map((e) => e.id));
          known.current = new Set(mine.map((e) => e.id));
        } else {
          for (const e of mine) {
            if (!known.current.has(e.id)) {
              known.current.add(e.id);
              toast.success(`New clip from ${app.name}: ${e.name}`);
              if (autoRef.current) void doImport(e);
            }
          }
        }
        if (alive) setClips(mine.slice(0, 20));
      } catch {
        /* ignore */
      }
    };
    scan();
    const t = setInterval(scan, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Poll this app's health so we can show a boot state and load the frame once up.
  useEffect(() => {
    let alive = true;
    const t = setInterval(() => {
      api
        .apps()
        .then((list) => {
          const a = list.find((x) => x.id === app.id);
          if (alive && a) setHealthy(a.state === "running" && a.healthy);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="appstudio-bg" onClick={onClose}>
      <div className="appstudio" onClick={(e) => e.stopPropagation()}>
        <div className="appstudio-h">
          <b>{app.name}</b>
          <span className={"plugin-live" + (healthy ? "" : " booting")}>{healthy ? "live" : "booting…"}</span>
          <span className="small" style={{ marginLeft: 4 }}>{app.url}</span>
          <div className="spacer" />
          <label className="plugin-check" title="Import every new clip this app produces, automatically">
            <input type="checkbox" checked={autoImport} onChange={(e) => setAutoImport(e.target.checked)} />
            Auto-import new
          </label>
          <a className="linkbtn" href={app.url} target="_blank" rel="noreferrer">
            New tab ↗
          </a>
          <button className="ghost icon-btn" onClick={onClose} title="Close">
            <Icon name="close" />
          </button>
        </div>

        <div className="appstudio-body">
          <div className="appstudio-frame">
            {healthy ? (
              <iframe src={app.url} title={app.name} />
            ) : (
              <div className="appstudio-boot">
                <div className="spinner" />
                Starting {app.name}… first boot can take ~10–20s.
              </div>
            )}
          </div>

          <div className="appstudio-side">
            <div className="recent-h">
              <span>Clips from {app.name}</span>
              <span className="badge">{clips.length}</span>
            </div>
            <div className="small" style={{ padding: "2px 2px 8px" }}>
              Create a clip in the app on the left — it shows up here, newest first.
            </div>
            {clips.length === 0 && <div className="muted small">No clips yet.</div>}
            {clips.map((e) => {
              const isNew = baseline.current ? !baseline.current.has(e.id) : false;
              const done = importedIds.has(e.id);
              return (
                <div key={e.id} className={"recent-row" + (isNew ? " fresh" : "")}>
                  <span className="recent-nm" title={e.name}>
                    {isNew && <span className="new-dot" />}
                    {e.name}
                  </span>
                  <button
                    className={done ? "ghost" : "primary"}
                    disabled={importing === e.id || done}
                    onClick={() => doImport(e)}
                  >
                    {done ? "Added ✓" : importing === e.id ? "…" : "Import"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
