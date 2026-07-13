import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { awaitJob } from "../jobs";
import { useStudio } from "../state";
import type { Asset, GeneratorStatus } from "../types";

// Working default inputs per generator input kind.
const SAMPLES: Record<string, string> = {
  lessonJson: JSON.stringify(
    {
      title: "Sample — f-strings",
      scenes: [
        {
          type: "title",
          text: "Python f-strings",
          subtitle: "sixty seconds",
          narration: "Ever glued strings together with plus signs and hated it? There's a better way.",
        },
        {
          type: "code",
          language: "python",
          code: "name = 'Ada'\nprint(f'Hello, {name}!')",
          title: "main.py",
          typingSpeed: 18,
          narration: "Put an f before the quote, and braces become windows into your variables.",
        },
        { type: "terminal", output: "Hello, Ada!", typingSpeed: 40, narration: "And there's our greeting." },
      ],
    },
    null,
    2
  ),
  funkyScenes: JSON.stringify(
    {
      fps: 30,
      scenes: [
        {
          code: "def greet(name):\n    return f\"Hello, {name}!\"\n\nprint(greet('World'))",
          language: "python",
          template: "panel",
          output: "Hello, World!",
        },
      ],
    },
    null,
    2
  ),
  htmlComposition: `<!doctype html>
<html>
<head><style>
  body{margin:0;background:#0e1230;color:#fff;font-family:Inter,sans-serif;
       display:flex;align-items:center;justify-content:center;height:100vh}
  h1{font-size:96px}
</style></head>
<body data-composition-duration="4">
  <h1 id="t">Hello HyperFrames</h1>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    gsap.from("#t",{opacity:0,y:60,duration:1.2,ease:"power3.out"});
  </script>
</body>
</html>`,
};

export function GenerateModal({
  projectId,
  onClose,
  onDone,
  initialGenerator,
}: {
  projectId: string;
  onClose: () => void;
  onDone: (a: Asset) => void;
  initialGenerator?: string;
}) {
  const [gens, setGens] = useState<GeneratorStatus[]>([]);
  const [sel, setSel] = useState<string>("");
  const [input, setInput] = useState("");
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    api.generators().then((g) => {
      setGens(g);
      const preset = initialGenerator && g.find((x) => x.id === initialGenerator);
      const first = preset || g.find((x) => x.available) || g[0];
      if (first) setSel(first.id);
    });
  }, []);

  const current = useMemo(() => gens.find((g) => g.id === sel), [gens, sel]);

  useEffect(() => {
    if (!current) return;
    setInput(SAMPLES[current.inputKind] || "");
    const p: Record<string, string> = {};
    current.params.forEach((ps) => (p[ps.flag] = ps.default || ""));
    setParams(p);
  }, [sel, gens]);

  const submit = async () => {
    if (!current) return;
    setBusy(true);
    setErr("");
    try {
      const { jobId } = await api.generate(projectId, current.id, input, params);
      const data = await awaitJob(jobId);
      if (data?.asset) {
        onDone(data.asset as Asset);
      } else {
        // Terminal SSE event was missed (resolved via poll). The generator already
        // registered the asset server-side, so reload the project to pick it up.
        await useStudio.getState().load(projectId);
        onClose();
      }
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Generate a clip</h3>

        <label>Generator</label>
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {gens.map((g) => (
            <option key={g.id} value={g.id} disabled={!g.available}>
              {g.name} {g.available ? "" : "(unavailable)"}
            </option>
          ))}
        </select>
        {current && !current.available && (
          <div className="small" style={{ color: "var(--danger)", marginTop: 6 }}>
            {current.buildHint || "Generator not available."}
          </div>
        )}
        {current && <div className="small" style={{ marginTop: 6 }}>{current.description}</div>}

        {current && current.params.length > 0 && (
          <div className="row" style={{ flexWrap: "wrap", marginTop: 8 }}>
            {current.params.map((ps) => (
              <div key={ps.flag} style={{ minWidth: 140 }}>
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
                  <input
                    type="checkbox"
                    checked={params[ps.flag] === "true"}
                    onChange={(e) => setParams({ ...params, [ps.flag]: e.target.checked ? "true" : "" })}
                    style={{ width: "auto" }}
                  />
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

        <label>Input ({current?.inputKind})</label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={12}
          style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}
        />

        {err && (
          <div className="small" style={{ color: "var(--danger)", marginTop: 8, whiteSpace: "pre-wrap" }}>
            {err}
          </div>
        )}

        <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button style={{ flex: "0 0 auto" }} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            style={{ flex: "0 0 auto" }}
            disabled={busy || !current?.available}
            onClick={submit}
          >
            {busy ? "Generating… (see progress)" : "Generate"}
          </button>
        </div>
        {busy && (
          <div className="small" style={{ marginTop: 8 }}>
            Rendering can take a while (voice model download on first run). Progress shows bottom-right.
          </div>
        )}
      </div>
    </div>
  );
}
