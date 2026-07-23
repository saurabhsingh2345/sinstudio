import { useState } from "react";

import { cn } from "@/lib/utils";
import { Timeline } from "./Timeline";
import { PreviewStage } from "./PreviewStage";
import { SpineArea } from "./SpineArea";
import type { EditDoc } from "../../types";
import type { Selection } from "./selection";
import type { AspectKey } from "./bridge";

export function CenterColumn({
  doc,
  aspect,
  selection,
  expanded,
  onToggleExpand,
  onSelect,
  total,
  reviewMode,
}: {
  doc: EditDoc;
  aspect: AspectKey;
  selection: Selection;
  expanded: Record<string, boolean>;
  onToggleExpand: (id: string) => void;
  onSelect: (s: Selection) => void;
  total: number;
  reviewMode?: boolean;
}) {
  // Bottom editor view: the new Premiere-style Timeline (default) or the legacy
  // card Spine. Persisted so a session keeps whichever the user prefers.
  const [view, setView] = useState<"timeline" | "spine">(
    () => (localStorage.getItem("studio-editor-view") as "timeline" | "spine") || "timeline"
  );
  const pick = (v: "timeline" | "spine") => {
    setView(v);
    localStorage.setItem("studio-editor-view", v);
  };

  return (
    <section className="relative flex min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      <PreviewStage doc={doc} aspect={aspect} selection={selection} total={total} />

      {!reviewMode && (
        <>
      <div className="flex shrink-0 items-center gap-1 border-t hairline bg-panel/60 px-3 pt-1.5">
        <button
          onClick={() => pick("timeline")}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            view === "timeline" ? "bg-panel-3 text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Timeline
        </button>
        <button
          onClick={() => pick("spine")}
          className={cn(
            "rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
            view === "spine" ? "bg-panel-3 text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          Spine
        </button>
      </div>

      {view === "timeline" ? (
        <Timeline doc={doc} selection={selection} onSelect={onSelect} total={total} />
      ) : (
        <SpineArea
          doc={doc}
          selection={selection}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
          total={total}
        />
      )}
        </>
      )}
    </section>
  );
}
