import { Scissors, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { detectFillerCues } from "../../fillerWords";
import { useStudio } from "../../state";
import type { CaptionCue, EditDoc } from "../../types";
import { captionTrack } from "./bridge";

export function TranscriptPanel({
  doc,
  onSelectCue,
}: {
  doc: EditDoc;
  onSelectCue: (cueId: string) => void;
}) {
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const removeCue = useStudio((s) => s.removeCue);
  const rippleCutRange = useStudio((s) => s.rippleCutRange);
  const cues = captionTrack(doc)?.cues ?? [];
  const fillers = detectFillerCues(cues);

  if (!cues.length) {
    return (
      <div className="border-t hairline px-3 py-3">
        <p className="text-[11px] text-muted-foreground">Transcribe a clip to edit the transcript here — click a line to seek.</p>
      </div>
    );
  }

  const cutCue = (cue: CaptionCue, ripple: boolean) => {
    if (ripple && cue.end > cue.start + 0.05) {
      rippleCutRange(cue.start, cue.end);
    } else {
      removeCue(cue.id);
    }
  };

  const cutAllFillers = () => {
    const sorted = [...fillers].sort((a, b) => b.start - a.start);
    for (const f of sorted) {
      if (f.end > f.start + 0.05) rippleCutRange(f.start, f.end);
      else removeCue(f.cueId);
    }
  };

  return (
    <div className="border-t hairline px-3 py-2">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div>
          <p className="text-[12px] font-medium">Transcript</p>
          <p className="text-[10px] text-muted-foreground">Click to seek · scissors ripple-cut from timeline</p>
        </div>
        {fillers.length > 0 && (
          <Button size="sm" variant="secondary" className="h-7 text-[10px]" onClick={cutAllFillers}>
            Cut {fillers.length} filler{fillers.length === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      <div className="scrollbar-thin max-h-48 space-y-1 overflow-y-auto">
        {cues.map((cue) => {
          const isFiller = fillers.some((f) => f.cueId === cue.id);
          return (
            <div
              key={cue.id}
              className={cn(
                "group flex items-start gap-1.5 rounded-md border hairline bg-panel-2/50 p-1.5",
                isFiller && "border-amber-500/30 bg-amber-500/5",
              )}
            >
              <button
                type="button"
                className="min-w-0 flex-1 text-left"
                onClick={() => {
                  setPlayhead(cue.start + 0.05);
                  onSelectCue(cue.id);
                }}
              >
                <span className="text-[10px] tabular text-muted-foreground">{cue.start.toFixed(1)}s</span>
                <p className="text-[11px] leading-snug text-foreground">{cue.text || "…"}</p>
              </button>
              <div className="flex shrink-0 flex-col gap-0.5 opacity-0 group-hover:opacity-100">
                <button
                  type="button"
                  title="Ripple-cut this span from the timeline"
                  className="rounded p-1 text-muted-foreground hover:bg-panel-3 hover:text-foreground"
                  onClick={() => cutCue(cue, true)}
                >
                  <Scissors className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title="Remove caption only"
                  className="rounded p-1 text-muted-foreground hover:bg-panel-3 hover:text-destructive"
                  onClick={() => cutCue(cue, false)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
