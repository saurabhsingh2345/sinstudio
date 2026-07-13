import type {
  AppStatus,
  EditDoc,
  ExportOptions,
  GeneratorStatus,
  JobEvent,
  LibraryEntry,
  LibrarySource,
} from "./types";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

export const api = {
  listProjects: () =>
    fetch("/api/projects").then((r) => j<{ id: string; name: string; updated: string }[]>(r)),
  createProject: (name: string) =>
    fetch("/api/projects", { method: "POST", body: JSON.stringify({ name }) }).then((r) =>
      j<EditDoc>(r)
    ),
  getProject: (id: string) => fetch(`/api/projects/${id}`).then((r) => j<EditDoc>(r)),
  saveProject: (doc: EditDoc) =>
    fetch(`/api/projects/${doc.id}`, { method: "PUT", body: JSON.stringify(doc) }).then((r) =>
      j<{ ok: boolean; version: number }>(r)
    ),
  generators: () => fetch("/api/generators").then((r) => j<GeneratorStatus[]>(r)),

  // Sibling-app supervisor (run/manage newaniAdv, funkycode, hyperframes).
  apps: () => fetch("/api/apps").then((r) => j<AppStatus[]>(r)),
  startApp: (id: string) =>
    fetch(`/api/apps/${id}/start`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  stopApp: (id: string) =>
    fetch(`/api/apps/${id}/stop`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  restartApp: (id: string) =>
    fetch(`/api/apps/${id}/restart`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  appLogs: (id: string) =>
    fetch(`/api/apps/${id}/logs`).then((r) => j<{ lines: string[] }>(r)),

  importAsset: (projId: string, file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    return fetch(`/api/projects/${projId}/assets`, { method: "POST", body: fd }).then((r) =>
      j<{ asset: any; version: number }>(r)
    );
  },
  generate: (projId: string, generatorId: string, input: string, params: Record<string, string>) =>
    fetch(`/api/projects/${projId}/generate`, {
      method: "POST",
      body: JSON.stringify({ generatorId, input, params }),
    }).then((r) => j<{ jobId: string }>(r)),
  waveform: (projId: string, assetId: string) =>
    fetch(`/api/projects/${projId}/waveform?asset=${assetId}`).then((r) => j<{ peaks: number[] }>(r)),
  transcribe: (projId: string, assetId: string) =>
    fetch(`/api/projects/${projId}/transcribe`, {
      method: "POST",
      body: JSON.stringify({ assetId }),
    }).then((r) => j<{ jobId: string }>(r)),
  renderFrame: (projId: string, t: number, preset?: string) =>
    fetch(`/api/projects/${projId}/frame?t=${t}${preset ? `&preset=${encodeURIComponent(preset)}` : ""}`).then((r) =>
      j<{ url: string }>(r)
    ),
  exportVideo: (projId: string, opts: ExportOptions = {}) =>
    fetch(`/api/projects/${projId}/export`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }).then((r) => j<{ jobId: string }>(r)),

  library: () =>
    fetch("/api/library").then((r) =>
      j<{ sources: LibrarySource[]; entries: LibraryEntry[] }>(r)
    ),
  importFromLibrary: (projId: string, path: string, name: string) =>
    fetch(`/api/projects/${projId}/library/import`, {
      method: "POST",
      body: JSON.stringify({ path, name }),
    }).then((r) => j<{ asset: any; version: number }>(r)),

  // Job control/recovery (used when an SSE terminal event is missed, and to
  // cancel a stuck/long job).
  getJob: (id: string) =>
    fetch(`/api/jobs/${id}`).then((r) =>
      j<{ id: string; kind: string; status: string; progress: number; message: string }>(r)
    ),
  cancelJob: (id: string) =>
    fetch(`/api/jobs/${id}/cancel`, { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
};

// subscribeJobs opens the SSE stream and invokes cb for every job event.
export function subscribeJobs(cb: (ev: JobEvent) => void): () => void {
  const es = new EventSource("/api/events");
  es.onmessage = (e) => {
    try {
      cb(JSON.parse(e.data));
    } catch {
      /* ignore keep-alives */
    }
  };
  return () => es.close();
}
