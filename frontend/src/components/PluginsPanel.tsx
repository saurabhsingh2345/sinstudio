import { useEffect, useState } from "react";
import { api } from "../api";
import { awaitJob } from "../jobs";
import { useStudio } from "../state";
import { toast } from "../toast";
import { SAMPLES } from "../generatorSamples";
import type { Asset, AppStatus, GeneratorStatus } from "../types";
import { Icon } from "./Icon";
import { AppsModal } from "./AppsModal";

// Per-plugin brand mark (gradient + initial) — a lightweight app "icon".
const MARK: Record<string, string> = {
  newaniadv: "linear-gradient(135deg,#6366f1,#8b5cf6)",
  hyperframes: "linear-gradient(135deg,#2dd4bf,#3b82f6)",
  funkycode: "linear-gradient(135deg,#f5a623,#f4556b)",
};

// Default timeline lane for a generated asset (mirrors AssetPanel.laneFor).
const laneFor = (a: Asset) =>
  a.kind === "audio" ? "t_music" : a.kind === "image" ? "t_overlay" : "t_video";

// PluginsPanel surfaces the sibling generator apps as first-class "plugins":
// pick one, tune its inputs, and Generate — the clip renders headless server-side
// and is imported (and optionally dropped on the timeline) automatically.
export function PluginsPanel({ projectId }: { projectId: string }) {
  const { addAsset, addClip, playhead } = useStudio();
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  const [apps, setApps] = useState<Record<string, AppStatus>>({});
  const [open, setOpen] = useState("");
  const [input, setInput] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [autoAdd, setAutoAdd] = useState(true);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  const [manage, setManage] = useState(false);

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
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const expand = (g: GeneratorStatus) => {
    if (open === g.id) {
      setOpen("");
      return;
    }
    setOpen(g.id);
    setErr("");
    setInput(SAMPLES[g.inputKind] || "");
    const p: Record<string, string> = {};
    g.params.forEach((ps) => (p[ps.flag] = ps.default || ""));
    setParams(p);
  };

  const run = async (g: GeneratorStatus) => {
    setBusy(g.id);
    setErr("");
    try {
      const { jobId } = await api.generate(projectId, g.id, input, params);
      const data = await awaitJob(jobId);
      const asset = data?.asset as Asset | undefined;
      if (asset) {
        addAsset(asset);
        if (autoAdd) addClip(laneFor(asset), asset.id, playhead);
        toast.success(`${g.name} → imported${autoAdd ? " & placed on timeline" : " into Media"}`);
      } else {
        // Terminal SSE event missed (resolved via poll) — the generator already
        // registered the asset server-side, so reload the project to pick it up.
        await useStudio.getState().load(projectId);
        toast.success(`${g.name} → imported into Media`);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <>
      <div className="panel-h">
        Plugins
        <div className="spacer" />
        <button className="ghost" onClick={() => setManage(true)} title="Run, stop & inspect app logs">
          <Icon name="apps" /> Manage
        </button>
      </div>

      <div className="plugins">
        <div className="small" style={{ padding: "10px 12px 4px" }}>
          Choose an app, tune its inputs, and generate — the clip renders and imports automatically.
        </div>

        {gens.map((g) => {
          const app = apps[g.id];
          const live = app?.state === "running" && app?.healthy;
          const isOpen = open === g.id;
          return (
            <div key={g.id} className={"plugin-card" + (isOpen ? " open" : "")}>
              <button className="plugin-head" onClick={() => expand(g)}>
                <span className="plugin-mark" style={{ background: MARK[g.id] || "var(--accent-grad)" }}>
                  {g.name.slice(0, 1)}
                </span>
                <span className="plugin-info">
                  <span className="plugin-name">
                    {g.name}
                    <i
                      className="plugin-dot"
                      style={{ background: g.available ? "var(--teal)" : "var(--danger)" }}
                      title={g.available ? "Ready to generate" : "Needs setup"}
                    />
                    {live && <span className="plugin-live">live</span>}
                  </span>
                  <span className="plugin-desc">{g.description}</span>
                </span>
                <Icon name={isOpen ? "up" : "down"} />
              </button>

              {isOpen && (
                <div className="plugin-body">
                  {!g.available && (
                    <div className="plugin-warn">{g.buildHint || "Generator not available."}</div>
                  )}

                  {app?.url && (
                    <a
                      className={"linkbtn" + (live ? "" : " disabled")}
                      href={live ? app.url : undefined}
                      target="_blank"
                      rel="noreferrer"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8 }}
                    >
                      Open live app ↗
                    </a>
                  )}

                  {g.params.length > 0 && (
                    <div className="plugin-params">
                      {g.params.map((ps) => (
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
                                onChange={(e) =>
                                  setParams({ ...params, [ps.flag]: e.target.checked ? "true" : "" })
                                }
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

                  <label>Input · {g.inputKind}</label>
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    rows={9}
                    spellCheck={false}
                    style={{ fontFamily: "'SF Mono', ui-monospace, monospace", fontSize: 11 }}
                  />

                  {err && <div className="plugin-warn">{err}</div>}

                  <label className="plugin-check" style={{ margin: "10px 0" }}>
                    <input type="checkbox" checked={autoAdd} onChange={(e) => setAutoAdd(e.target.checked)} />
                    Add to timeline at playhead
                  </label>

                  <button
                    className="primary"
                    style={{ width: "100%" }}
                    disabled={busy === g.id || !g.available}
                    onClick={() => run(g)}
                  >
                    {busy === g.id ? (
                      "Generating…"
                    ) : (
                      <>
                        <Icon name="generate" /> Generate &amp; import
                      </>
                    )}
                  </button>
                  {busy === g.id && (
                    <div className="small" style={{ marginTop: 8 }}>
                      Rendering can take a while (voice model downloads on first run). Progress shows bottom-right.
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {gens.length === 0 && <div className="muted" style={{ padding: 12 }}>No plugins configured.</div>}
      </div>

      {manage && (
        <AppsModal
          onClose={() => setManage(false)}
          onGenerate={(id) => {
            setManage(false);
            const g = gens.find((x) => x.id === id);
            if (g && open !== g.id) expand(g);
          }}
        />
      )}
    </>
  );
}
