import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { awaitJob } from "../jobs";
import { useStudio } from "../state";
import { toast } from "../toast";
import { SAMPLES } from "../generatorSamples";
import type { Asset, AppStatus, GeneratorStatus, LibraryEntry } from "../types";
import { Icon } from "./Icon";
import { AppStudio } from "./AppStudio";

// Per-plugin brand mark (gradient + initial) — a lightweight app "icon".
const MARK: Record<string, string> = {
  newaniadv: "linear-gradient(135deg,#6366f1,#8b5cf6)",
  hyperframes: "linear-gradient(135deg,#2dd4bf,#3b82f6)",
  funkycode: "linear-gradient(135deg,#f5a623,#f4556b)",
};

// Which Library source ids hold each app's outputs (see backend library candidates).
const SOURCES: Record<string, string[]> = {
  newaniadv: ["newaniadv", "newaniadv-root"],
  hyperframes: ["hyperframes", "hyper-app"],
  funkycode: ["funkycode"],
};

// Whether an app produces spoken narration. Only newaniAdv has TTS; the others
// render silent motion — surfaced so "no voice" is never a surprise.
const VOICE: Record<string, boolean> = { newaniadv: true, hyperframes: false, funkycode: false };

// Default timeline lane for an imported asset (mirrors AssetPanel.laneFor).
const laneFor = (a: Asset) =>
  a.kind === "audio" ? "t_music" : a.kind === "image" ? "t_overlay" : "t_video";

export function PluginsPanel({ projectId }: { projectId: string }) {
  const { addAsset, addClip, playhead } = useStudio();
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  const [apps, setApps] = useState<Record<string, AppStatus>>({});
  const [open, setOpen] = useState("");
  const [studioFor, setStudioFor] = useState<AppStatus | null>(null);

  useEffect(() => {
    api.generators().then(setGens).catch(() => {});
  }, []);

  // Poll live app status (the browsable dev-servers) for the status dots.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .apps()
        .then((list) => alive && setApps(Object.fromEntries(list.map((a) => [a.id, a]))))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Import a discovered library clip into Media (and, by default, the timeline).
  const importEntry = async (e: LibraryEntry, toTimeline: boolean) => {
    const { asset } = await api.importFromLibrary(projectId, e.path, e.name);
    addAsset(asset);
    if (toTimeline) addClip(laneFor(asset), asset.id, playhead);
    toast.success(`Imported ${e.name}${toTimeline ? " → timeline" : ""}`);
    return asset as Asset;
  };

  // Open an app's own Studio inside Studio — start its dev server if needed.
  const openStudio = async (g: GeneratorStatus) => {
    const app = apps[g.id];
    if (!app) {
      toast.error("This app isn't configured as a runnable dev server.");
      return;
    }
    if (app.state !== "running") {
      try {
        await api.startApp(g.id);
        toast.info(`Starting ${g.name}… it runs in the background (Studio manages it).`);
      } catch (e) {
        toast.error(`Couldn't start ${g.name}: ${(e as Error).message}`);
        return;
      }
    }
    setStudioFor({ ...app, id: g.id });
  };

  return (
    <>
      <div className="panel-h">
        Plugins
        <div className="spacer" />
      </div>

      <div className="plugins">
        <div className="small" style={{ padding: "10px 12px 4px" }}>
          Open an app right inside Studio, create there, and its clips import automatically. No JSON needed.
        </div>

        {gens.map((g) => {
          const app = apps[g.id];
          const live = app?.state === "running" && app?.healthy;
          const booting = app?.state === "running" && !app?.healthy;
          const isOpen = open === g.id;
          return (
            <div key={g.id} className={"plugin-card" + (isOpen ? " open" : "")}>
              <button className="plugin-head" onClick={() => setOpen(isOpen ? "" : g.id)}>
                <span className="plugin-mark" style={{ background: MARK[g.id] || "var(--accent-grad)" }}>
                  {g.name.slice(0, 1)}
                </span>
                <span className="plugin-info">
                  <span className="plugin-name">
                    {g.name}
                    {live && <span className="plugin-live">live</span>}
                    {booting && <span className="plugin-live booting">booting…</span>}
                  </span>
                  <span className="plugin-desc">{g.description}</span>
                  <span className={"plugin-voice " + (VOICE[g.id] ? "on" : "")}>
                    <Icon name={VOICE[g.id] ? "audio" : "eyeOff"} />
                    {VOICE[g.id] ? "narrated (TTS voice)" : "silent — no voiceover"}
                  </span>
                </span>
                <Icon name={isOpen ? "up" : "down"} />
              </button>

              {isOpen && (
                <div className="plugin-body">
                  {!g.available && (
                    <div className="plugin-warn">{g.buildHint || "Generator not available."}</div>
                  )}

                  {app ? (
                    <button className="primary" style={{ width: "100%" }} onClick={() => openStudio(g)}>
                      <Icon name="apps" /> {app.state === "running" ? "Open" : "Start & open"} {g.name} in Studio
                    </button>
                  ) : (
                    <div className="small">No dev-server configured for this app.</div>
                  )}

                  <RecentClips
                    appId={g.id}
                    appName={g.name}
                    onImport={importEntry}
                  />

                  <Advanced generator={g} projectId={projectId} onImport={importEntry} />
                </div>
              )}
            </div>
          );
        })}

        {gens.length === 0 && <div className="muted" style={{ padding: 12 }}>No plugins configured.</div>}
      </div>

      {studioFor && (
        <AppStudio
          app={studioFor}
          sources={SOURCES[studioFor.id] || []}
          onClose={() => setStudioFor(null)}
          onImport={(e, toTL) => importEntry(e, toTL)}
        />
      )}
    </>
  );
}

// RecentClips lists an app's most recent outputs (scanned from the Library) with
// one-click import. It polls so a clip you just made in the app shows up here.
function RecentClips({
  appId,
  appName,
  onImport,
}: {
  appId: string;
  appName: string;
  onImport: (e: LibraryEntry, toTimeline: boolean) => Promise<Asset>;
}) {
  const [clips, setClips] = useState<LibraryEntry[]>([]);
  const [busy, setBusy] = useState("");
  const srcs = SOURCES[appId] || [];

  const refresh = () =>
    api
      .library()
      .then((d) =>
        setClips(
          d.entries
            .filter((e) => srcs.includes(e.source))
            .sort((a, b) => (a.modTime < b.modTime ? 1 : -1))
            .slice(0, 6)
        )
      )
      .catch(() => {});

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [appId]);

  return (
    <div className="recent">
      <div className="recent-h">
        <span>Recent clips from {appName}</span>
        <button className="ghost" onClick={refresh} title="Rescan">
          ↻
        </button>
      </div>
      {clips.length === 0 ? (
        <div className="small" style={{ padding: "4px 2px" }}>
          None yet — create one in the app and it appears here.
        </div>
      ) : (
        clips.map((e) => (
          <div key={e.id} className="recent-row">
            <span className="recent-nm" title={e.name}>
              {e.name}
            </span>
            <button
              className="ghost"
              disabled={busy === e.id}
              onClick={async () => {
                setBusy(e.id);
                try {
                  await onImport(e, true);
                } catch (err) {
                  toast.error("Import failed: " + (err as Error).message);
                } finally {
                  setBusy("");
                }
              }}
            >
              {busy === e.id ? "…" : "Import"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}

// Advanced is the collapsed headless-generate path (author input in Studio and
// render server-side). Kept for power users; the native app flow above is the
// primary way in.
function Advanced({
  generator,
  projectId,
  onImport,
}: {
  generator: GeneratorStatus;
  projectId: string;
  onImport: (e: LibraryEntry, toTimeline: boolean) => Promise<Asset>;
}) {
  const { addAsset, addClip, playhead } = useStudio();
  const [show, setShow] = useState(false);
  const [input, setInput] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [autoAdd, setAutoAdd] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const seeded = useRef(false);

  useEffect(() => {
    if (show && !seeded.current) {
      seeded.current = true;
      setInput(SAMPLES[generator.inputKind] || "");
      const p: Record<string, string> = {};
      generator.params.forEach((ps) => (p[ps.flag] = ps.default || ""));
      setParams(p);
    }
  }, [show]);

  const run = async () => {
    setBusy(true);
    setErr("");
    try {
      const { jobId } = await api.generate(projectId, generator.id, input, params);
      const data = await awaitJob(jobId);
      const asset = data?.asset as Asset | undefined;
      if (asset) {
        addAsset(asset);
        if (autoAdd) addClip(laneFor(asset), asset.id, playhead);
        toast.success(`${generator.name} → imported${autoAdd ? " & placed" : ""}`);
      } else {
        await useStudio.getState().load(projectId);
        toast.success(`${generator.name} → imported`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="advanced">
      <button className="advanced-t" onClick={() => setShow((s) => !s)}>
        <Icon name={show ? "up" : "down"} /> Advanced · author input &amp; render headless
      </button>
      {show && (
        <div className="advanced-body">
          {generator.params.length > 0 && (
            <div className="plugin-params">
              {generator.params.map((ps) => (
                <div key={ps.flag} className="field" style={{ minWidth: 118, flex: 1 }}>
                  <label>{ps.label}</label>
                  {ps.type === "enum" ? (
                    <select
                      value={params[ps.flag] || ""}
                      onChange={(e) => setParams({ ...params, [ps.flag]: e.target.value })}
                    >
                      {ps.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : ps.type === "bool" ? (
                    <label className="plugin-check">
                      <input
                        type="checkbox"
                        checked={params[ps.flag] === "true"}
                        onChange={(e) => setParams({ ...params, [ps.flag]: e.target.checked ? "true" : "" })}
                      />
                      on
                    </label>
                  ) : (
                    <input
                      value={params[ps.flag] || ""}
                      onChange={(e) => setParams({ ...params, [ps.flag]: e.target.value })}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
          <label>Input · {generator.inputKind}</label>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={8}
            spellCheck={false}
            style={{ fontFamily: "'SF Mono', ui-monospace, monospace", fontSize: 11 }}
          />
          {err && <div className="plugin-warn">{err}</div>}
          <label className="plugin-check" style={{ margin: "10px 0" }}>
            <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
            Add to timeline at playhead
          </label>
          <button className="primary" style={{ width: "100%" }} disabled={busy || !generator.available} onClick={run}>
            {busy ? "Generating…" : <><Icon name="generate" /> Generate &amp; import</>}
          </button>
          {busy && (
            <div className="small" style={{ marginTop: 8 }}>
              Rendering can take a while. Progress shows bottom-right.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
