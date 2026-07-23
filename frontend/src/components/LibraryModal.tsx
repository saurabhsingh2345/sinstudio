import { useEffect, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api";
import { toast } from "../toast";
import type { Asset, LibraryEntry, LibrarySource } from "../types";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ModalField, StudioModal } from "./studio/StudioModal";

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
    [entries, filter],
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
    <StudioModal
      title="Library"
      onClose={onClose}
      width="max-w-2xl"
      headerActions={
        <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-[12px]" onClick={refresh} disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          Rescan
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
        <p className="text-[12px] text-muted-foreground">
          Clips from your sibling products and the ingest inbox — one click to add to this project.
        </p>

        <ModalField label="Source">
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="h-9 bg-panel-2 text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources ({entries.length})</SelectItem>
              {sources.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name} ({entries.filter((e) => e.source === s.id).length})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ModalField>

        <div className="max-h-[52vh] space-y-1 overflow-auto rounded-lg border hairline bg-panel-2/50 p-1">
          {loading && <p className="p-4 text-center text-[13px] text-muted-foreground">Scanning…</p>}
          {!loading && shown.length === 0 && (
            <p className="p-4 text-center text-[13px] text-muted-foreground">No clips found.</p>
          )}
          {shown.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-panel-3"
            >
              <div className="grid h-10 w-14 shrink-0 place-items-center rounded bg-panel-3 font-mono text-[10px] font-medium text-muted-foreground">
                {e.ext.replace(".", "").toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-medium">{e.name}</div>
                <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="rounded bg-brand-soft px-1.5 py-0.5 text-brand">{srcName(e.source)}</span>
                  <span>{(e.size / 1e6).toFixed(1)} MB</span>
                  <span>·</span>
                  <span>{e.modTime.replace("T", " ").replace("Z", "")}</span>
                </div>
              </div>
              <Button size="sm" className="h-8 shrink-0" disabled={importing === e.id} onClick={() => importOne(e)}>
                {importing === e.id ? "…" : "Add"}
              </Button>
            </div>
          ))}
        </div>
      </div>
    </StudioModal>
  );
}
