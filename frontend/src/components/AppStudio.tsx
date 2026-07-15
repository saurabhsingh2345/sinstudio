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
  // everHealthy latches true the first time the app answers its health probe.
  // The iframe mounts once on that transition and is never remounted — otherwise
  // transient probe flaps (the Next dev server pauses while compiling) would
  // remount it and trigger an endless Fast-Refresh full-reload loop.
  const [everHealthy, setEverHealthy] = useState(app.state === "running" && app.healthy);
  const [autoImport, setAutoImport] = useState(false);
  const [importing, setImporting] = useState("");
  const [importedIds, setImportedIds] = useState<Set<string>>(new Set());
  const baseline = useRef<Set<string> | null>(null); // clip ids that existed when we opened
  const known = useRef<Set<string>>(new Set());
  const sizes = useRef<Map<string, number>>(new Map()); // last seen size per id, to settle still-writing renders
  const autoRef = useRef(autoImport);
  autoRef.current = autoImport;

  // Sources holding freshly created/downloaded clips — treated as "this app's"
  // output while its studio is open (apps often download to the browser, which
  // lands in the watched Downloads folder rather than the app's own dir).
  const isFresh = (src: string) =>
    src === "downloads" || src === "inbox" || src.startsWith("watch") || sources.includes(src);

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
        const all = d.entries.filter((e) => isFresh(e.source));
        // The app's own output dir (server-written clips) always shows; clips
        // from the watched Downloads/inbox folders only show once they're NEW
        // (created after opening) so pre-existing downloads don't clutter.
        if (baseline.current === null) {
          baseline.current = new Set(all.map((e) => e.id));
          known.current = new Set(all.map((e) => e.id));
        } else {
          for (const e of all) {
            if (!known.current.has(e.id)) {
              // A render being written grows between scans — hold off until its
              // size is stable for one full poll so we never import a partial file.
              const last = sizes.current.get(e.id);
              sizes.current.set(e.id, e.size);
              if (last === undefined || last !== e.size || e.size === 0) continue;
              known.current.add(e.id);
              toast.success(`New clip: ${e.name}`);
              if (autoRef.current) void doImport(e);
            }
          }
        }
        const shown = all
          .filter((e) => sources.includes(e.source) || !baseline.current!.has(e.id))
          .sort((a, b) => (a.modTime < b.modTime ? 1 : -1));
        if (alive) setClips(shown.slice(0, 20));
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

  // Poll health only until the app first answers, then stop (and never remount).
  useEffect(() => {
    if (everHealthy) return;
    let alive = true;
    const t = setInterval(() => {
      api
        .apps()
        .then((list) => {
          const a = list.find((x) => x.id === app.id);
          if (alive && a && a.state === "running" && a.healthy) setEverHealthy(true);
        })
        .catch(() => {});
    }, 1500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [everHealthy]);

  return (
    <div className="appstudio-bg" onClick={onClose}>
      <div className="appstudio" onClick={(e) => e.stopPropagation()}>
        <div className="appstudio-h">
          <b>{app.name}</b>
          <span className={"plugin-live" + (everHealthy ? "" : " booting")}>{everHealthy ? "live" : "booting…"}</span>
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
            {everHealthy ? (
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
