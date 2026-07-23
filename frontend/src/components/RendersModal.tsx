import { useEffect, useState } from "react";
import { Copy, Download, RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api";
import { toast } from "../toast";
import { useJobs } from "../jobs";
import type { RenderEntry } from "../types";
import { Button } from "@/components/ui/button";
import { ModalProgress, StudioModal } from "./studio/StudioModal";

const fmtSize = (b: number) => (b > 1 << 20 ? (b / (1 << 20)).toFixed(1) + " MB" : Math.max(1, Math.round(b / 1024)) + " KB");
const fmtWhen = (iso: string) => {
  const d = new Date(iso);
  return isNaN(+d) ? iso : d.toLocaleString();
};

export function RendersModal({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { jobs, cancel, retry, dismiss } = useJobs();
  const exportJobs = Object.values(jobs).filter((j) => j.kind === "export");
  const [renders, setRenders] = useState<RenderEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = () => {
    setLoading(true);
    api
      .listRenders(projectId)
      .then((d) => setRenders(d.renders))
      .catch((e) => toast.error(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, [projectId]);

  const doneCount = exportJobs.filter((j) => j.status === "done").length;
  useEffect(() => {
    if (doneCount) refresh();
  }, [doneCount]);

  const del = async (name: string) => {
    try {
      await api.deleteRender(projectId, name);
      setRenders((r) => r.filter((x) => x.name !== name));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const copyLink = async (url: string) => {
    const abs = url.startsWith("http") ? url : `${window.location.origin}${url}`;
    await navigator.clipboard.writeText(abs);
    toast.success("Share link copied");
  };

  const active = exportJobs.filter((j) => j.status === "queued" || j.status === "running");
  const failed = exportJobs.filter((j) => j.status === "error" || j.status === "canceled");

  return (
    <StudioModal
      title="Render queue"
      onClose={onClose}
      width="max-w-xl"
      headerActions={
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      }
      footer={
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {active.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">In progress</h3>
            {active.map((j) => (
              <div key={j.id} className="space-y-2 rounded-lg bg-panel-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="rounded bg-brand-soft px-2 py-0.5 text-[11px] font-medium text-brand">
                    {j.status === "queued" ? "Queued" : "Rendering"}
                  </span>
                  <Button variant="ghost" size="sm" className="h-7 text-[12px]" onClick={() => cancel(j.id)}>
                    Cancel
                  </Button>
                </div>
                <ModalProgress label="" progress={j.progress} />
              </div>
            ))}
          </div>
        )}

        {failed.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Failed</h3>
            {failed.map((j) => (
              <div key={j.id} className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
                <span className="shrink-0 rounded bg-destructive/20 px-2 py-0.5 text-[11px] font-medium text-destructive">
                  {j.status === "canceled" ? "Canceled" : "Failed"}
                </span>
                <p className="min-w-0 flex-1 text-[12px] text-muted-foreground">{j.message}</p>
                <div className="flex shrink-0 gap-1">
                  <Button variant="secondary" size="sm" className="h-7 text-[12px]" onClick={() => retry(j.id)}>
                    Retry
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => dismiss(j.id)}>
                    ×
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">History</h3>
          {loading ? (
            <p className="text-[13px] text-muted-foreground">Loading…</p>
          ) : renders.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No exports yet. Use Export to render one.</p>
          ) : (
            <div className="space-y-1 rounded-lg border hairline bg-panel-2/50 p-1">
              {renders.map((r) => (
                <div key={r.name} className="flex items-center gap-2 rounded-md px-2 py-2 hover:bg-panel-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{r.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {fmtSize(r.size)} · {fmtWhen(r.created)}
                    </div>
                  </div>
                  <Button variant="secondary" size="sm" className="h-8 gap-1.5" asChild>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      <Download className="h-3.5 w-3.5" />
                      Download
                    </a>
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" title="Copy share link" onClick={() => void copyLink(r.url)}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0 text-muted-foreground" onClick={() => del(r.name)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </StudioModal>
  );
}
