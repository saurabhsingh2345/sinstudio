import { useEffect, useState } from "react";
import { api } from "../api";

export function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<{ id: string; name: string; updated: string }[]>([]);
  const [name, setName] = useState("");

  const refresh = () => api.listProjects().then(setProjects).catch(console.error);
  useEffect(() => {
    refresh();
  }, []);

  const create = async () => {
    const doc = await api.createProject(name || "Untitled");
    setName("");
    onOpen(doc.id);
  };

  return (
    <div className="projects">
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span
          className="brand-mark"
          style={{ width: 34, height: 34, borderRadius: 10 }}
        />
        <h1 style={{ margin: 0 }}>Studio</h1>
      </div>
      <p className="muted" style={{ marginTop: 12 }}>
        Assemble clips from newaniAdv, HyperFrames &amp; imports into a finished video — timeline,
        music, transcript, background layers, server-side FFmpeg export.
      </p>
      <div className="row" style={{ marginTop: 20 }}>
        <input
          placeholder="New project name…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create()}
        />
        <button className="primary" style={{ flex: "0 0 auto" }} onClick={create}>
          Create project
        </button>
      </div>
      <div className="plist">
        {projects.map((p) => (
          <div key={p.id} className="pcard" onClick={() => onOpen(p.id)}>
            <div>
              <div style={{ fontWeight: 600 }}>{p.name}</div>
              <div className="small">{p.id}</div>
            </div>
            <div className="spacer" />
            <div className="small">{p.updated?.replace("T", " ").replace("Z", "")}</div>
          </div>
        ))}
        {projects.length === 0 && <div className="muted">No projects yet — create one above.</div>}
      </div>
    </div>
  );
}
