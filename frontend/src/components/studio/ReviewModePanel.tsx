import { CheckCircle2, Clapperboard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStudio } from "../../state";
import type { Clip } from "../../types";
import { clipPlayDur } from "../../types";
import { Field, SliderRow } from "./inspector-bits";
import { StylePresetQuickPick } from "./StylePresetsSection";
import type { PostRecordSummary } from "./PostRecordChecklist";

export function ReviewModePanel({
  summary,
  onExit,
  onExport,
}: {
  summary: PostRecordSummary;
  onExit: () => void;
  onExport: () => void;
}) {
  const updateClip = useStudio((s) => s.updateClip);
  const doc = useStudio((s) => s.doc);

  const primary = summary.primaryScreen;
  let clip: Clip | undefined;
  if (primary && doc) {
    clip = doc.tracks.find((t) => t.id === primary.trackId)?.clips?.find((c) => c.id === primary.clipId);
  }

  const items = [
    { done: true, text: `${summary.trackCount} track${summary.trackCount === 1 ? "" : "s"} on the timeline` },
    summary.hadCursor
      ? {
          done: summary.autoZoomClips > 0,
          text:
            summary.autoZoomClips > 0
              ? `Auto-zoom on ${summary.autoZoomClips} clip${summary.autoZoomClips === 1 ? "" : "s"}`
              : "Cursor tracked — tweak zooms in the full editor",
        }
      : null,
    { done: false, text: "Pick a style preset for instant polish" },
    { done: false, text: "Export when you're happy — or open the full editor" },
  ].filter(Boolean) as { done: boolean; text: string }[];

  return (
    <aside className="scrollbar-thin flex min-h-0 flex-col overflow-y-auto border-l hairline bg-panel">
      <div className="flex items-center justify-between border-b hairline px-3 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[13px] font-semibold">
            <Clapperboard className="h-4 w-4 text-brand" />
            Quick review
          </div>
          <p className="text-[10px] text-muted-foreground">Trim, style, export — or open the full editor.</p>
        </div>
        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onExit} aria-label="Close review">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-3 p-3">
        <ul className="space-y-1">
          {items.map((item) => (
            <li key={item.text} className="flex gap-2 text-[11px] leading-snug">
              <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${item.done ? "text-signal" : "text-muted-foreground/40"}`} />
              <span className={item.done ? "text-foreground" : "text-muted-foreground"}>{item.text}</span>
            </li>
          ))}
        </ul>

        {primary && clip && (
          <>
            <div className="rounded-lg border hairline bg-panel-2/50 p-2.5">
              <p className="mb-2 text-[11px] font-medium">Trim recording</p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="In">
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={clip.in}
                    onChange={(e) => {
                      const v = Math.max(0, +e.target.value || 0);
                      updateClip(primary.trackId, primary.clipId, { in: Math.min(v, clip!.out - 0.1) });
                    }}
                    className="h-7 w-full rounded border hairline bg-panel px-1.5 text-[12px] outline-none focus:border-brand/50"
                  />
                </Field>
                <Field label="Out">
                  <input
                    type="number"
                    step={0.1}
                    min={0}
                    value={clip.out}
                    onChange={(e) => {
                      const v = Math.max(clip!.in + 0.1, +e.target.value || 0);
                      updateClip(primary.trackId, primary.clipId, { out: v });
                    }}
                    className="h-7 w-full rounded border hairline bg-panel px-1.5 text-[12px] outline-none focus:border-brand/50"
                  />
                </Field>
              </div>
              <p className="mt-1.5 text-[10px] tabular text-muted-foreground">
                Duration {clipPlayDur(clip).toFixed(1)}s
              </p>
            </div>

            <div>
              <p className="mb-1.5 text-[11px] font-medium">Style preset</p>
              <StylePresetQuickPick trackId={primary.trackId} clipId={primary.clipId} assetId={primary.assetId} />
            </div>

            <SliderRow
              label="Motion blur"
              value={Math.round((clip.motionBlur ?? 0) * 100)}
              min={0}
              max={100}
              onChange={(v) =>
                updateClip(primary.trackId, primary.clipId, { motionBlur: v > 0 ? v / 100 : undefined })
              }
              fmt={(v) => `${v}%`}
            />
            <p className="-mt-1 text-[10px] text-muted-foreground">
              Smooths camera zooms on export (preview is approximate).
            </p>
          </>
        )}

        <div className="flex flex-col gap-1.5 pt-1">
          <Button size="sm" className="h-8 w-full text-xs" onClick={onExport}>
            Export video
          </Button>
          <Button size="sm" variant="secondary" className="h-8 w-full text-xs" onClick={onExit}>
            Open full editor
          </Button>
        </div>
      </div>
    </aside>
  );
}
