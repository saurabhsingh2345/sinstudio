import { MapPin, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useStudio } from "../../state";
import type { EditDoc, Marker } from "../../types";
import { fmtTC } from "./bridge";
import { ColorSwatch, Field, Section } from "./inspector-bits";

const MARKER_COLORS = ["#f4b740", "#ef4444", "#22c55e", "#3b82f6", "#a855f7", "#ec4899"];

function MarkerEditor({ marker, onDeleted }: { marker: Marker; onDeleted?: () => void }) {
  const updateMarker = useStudio((s) => s.updateMarker);
  const removeMarker = useStudio((s) => s.removeMarker);
  const setPlayhead = useStudio((s) => s.setPlayhead);

  return (
    <Section label="Marker">
      <Field label="Time">
        <div className="flex flex-1 items-center justify-between gap-2">
          <span className="text-[12px] tabular text-muted-foreground">{fmtTC(marker.t)}</span>
          <Button size="sm" variant="ghost" className="h-7 shrink-0 text-[11px]" onClick={() => setPlayhead(marker.t)}>
            Go to
          </Button>
        </div>
      </Field>
      <Field label="Label">
        <Input
          value={marker.label ?? ""}
          onChange={(e) => updateMarker(marker.id, { label: e.target.value })}
          className="h-7 bg-panel-2 text-[12px]"
          placeholder="Chapter title…"
        />
      </Field>
      <Field label="Color">
        <div className="flex flex-wrap gap-1.5">
          {MARKER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={c}
              onClick={() => updateMarker(marker.id, { color: c })}
              className={cn(
                "h-5 w-5 rounded-full border-2 transition-transform hover:scale-110",
                (marker.color || "#f4b740") === c ? "border-foreground" : "border-transparent"
              )}
              style={{ background: c }}
            />
          ))}
          <ColorSwatch color={marker.color || "#f4b740"} onChange={(c) => updateMarker(marker.id, { color: c })} />
        </div>
      </Field>
      <Button
        variant="ghost"
        size="sm"
        className="mt-1 w-full justify-center gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
        onClick={() => {
          removeMarker(marker.id);
          onDeleted?.();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete marker
      </Button>
    </Section>
  );
}

function MarkerList({
  markers,
  selectedId,
  onSelect,
}: {
  markers: Marker[];
  selectedId?: string;
  onSelect?: (id: string) => void;
}) {
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const addMarker = useStudio((s) => s.addMarker);

  return (
    <Section label="Markers">
      {markers.length === 0 ? (
        <p className="px-1 text-[10px] text-muted-foreground">
          No markers yet. Press <kbd className="rounded border hairline px-1">M</kbd> at the playhead,{" "}
          <kbd className="rounded border hairline px-1">[</kbd>/<kbd className="rounded border hairline px-1">]</kbd> to jump, or use the timeline toolbar.
        </p>
      ) : (
        <ul className="space-y-1">
          {markers.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => {
                  setPlayhead(m.t);
                  onSelect?.(m.id);
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] hover:bg-panel-2",
                  selectedId === m.id && "bg-panel-2 ring-1 ring-brand/30"
                )}
              >
                <MapPin className="h-3 w-3 shrink-0" style={{ color: m.color || "#f4b740" }} />
                <span className="min-w-0 flex-1 truncate">{m.label || "Marker"}</span>
                <span className="shrink-0 tabular text-muted-foreground">{fmtTC(m.t)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Button size="sm" variant="outline" className="mt-2 h-7 w-full text-[11px]" onClick={addMarker}>
        Add at playhead
      </Button>
    </Section>
  );
}

/** Marker list (project panel) or single-marker editor (when a marker is selected). */
export function MarkersSection({
  doc,
  markerId,
  onSelectMarker,
  onDeleted,
}: {
  doc: EditDoc;
  markerId?: string;
  onSelectMarker?: (id: string) => void;
  onDeleted?: () => void;
}) {
  const markers = [...(doc.markers ?? [])].sort((a, b) => a.t - b.t);
  const selected = markerId ? markers.find((m) => m.id === markerId) : undefined;

  if (selected) return <MarkerEditor marker={selected} onDeleted={onDeleted} />;
  return <MarkerList markers={markers} selectedId={markerId} onSelect={onSelectMarker} />;
}
