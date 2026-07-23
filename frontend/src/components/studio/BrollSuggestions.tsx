import { Wand2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { timelineGaps } from "../../rippleCut";
import { useStudio } from "../../state";
import type { EditDoc } from "../../types";
import { toast } from "../../toast";

export function BrollSuggestions({
  doc,
  onGenerate,
}: {
  doc: EditDoc;
  onGenerate: (gapStart: number) => void;
}) {
  const setPlayhead = useStudio((s) => s.setPlayhead);
  const gaps = timelineGaps(doc, 1.5);

  if (!gaps.length) return null;

  return (
    <div className="border-t hairline px-3 py-2">
      <p className="mb-1.5 text-[12px] font-medium">B-roll gaps</p>
      <p className="mb-2 text-[10px] text-muted-foreground">Empty spans where a generated clip could go.</p>
      <div className="space-y-1">
        {gaps.slice(0, 4).map((g) => (
          <div key={`${g.start}-${g.end}`} className="flex items-center gap-1.5 rounded border hairline bg-panel-2/50 px-2 py-1">
            <button
              type="button"
              className="min-w-0 flex-1 text-left text-[11px] tabular text-muted-foreground hover:text-foreground"
              onClick={() => setPlayhead(g.start)}
            >
              {g.start.toFixed(1)}–{g.end.toFixed(1)}s ({g.duration.toFixed(1)}s)
            </button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-[10px]"
              title="Jump to Plugins tab and generate B-roll here"
              onClick={() => {
                setPlayhead(g.start);
                onGenerate(g.start);
                toast.info(`Playhead at gap — pick a plugin to generate B-roll`);
              }}
            >
              <Wand2 className="mr-0.5 h-3 w-3" /> Fill
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
