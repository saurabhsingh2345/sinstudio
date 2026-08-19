import { CheckCircle2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StylePresetQuickPick } from "./StylePresetsSection";

export interface PostRecordSummary {
  trackCount: number;
  autoZoomClips: number;
  hadCursor: boolean;
  /** Primary screen recording clip — for one-click style presets. */
  primaryScreen?: { trackId: string; clipId: string; assetId: string };
  /**
   * Set when the recording is a different shape from the project, which is what
   * happens the moment you record a window into a project that started as a
   * whole screen. The canvas only adopts the FIRST clip, so this one arrives in
   * a frame it does not fit, and gets letterboxed.
   *
   * Offered rather than done: reshaping a canvas with a timeline already built
   * against it moves everything already placed, and the last recording is not
   * automatically the one the project should be shaped around. But saying
   * nothing leaves someone looking at bars with no idea what put them there.
   */
  shapeMismatch?: { width: number; height: number; onMatch: () => void };
}

export interface ChecklistItem {
  done: boolean;
  text: string;
}

/**
 * What the checklist says, as data.
 *
 * Out of the component so it can be tested: this is where the shape-mismatch
 * line either appears or does not, and that line is the only warning anyone
 * gets that a recording arrived in a frame it does not fit.
 */
export function checklistItems(summary: PostRecordSummary): ChecklistItem[] {
  return [
    { done: true, text: `${summary.trackCount} track${summary.trackCount === 1 ? "" : "s"} placed on the timeline` },
    summary.hadCursor
      ? {
          done: summary.autoZoomClips > 0,
          text:
            summary.autoZoomClips > 0
              ? `Auto-zoom on ${summary.autoZoomClips} clip${summary.autoZoomClips === 1 ? "" : "s"} — drag keyframes to tweak`
              : "Cursor tracked — no zooms fit this clip length",
        }
      : null,
    summary.shapeMismatch
      ? {
          done: false,
          text: `This recording is a different shape from the project, so it has bars — match the canvas to it?`,
        }
      : null,
    { done: false, text: "Pick a style preset below for instant polish" },
    { done: false, text: "Transcribe for captions — Captions tab or import with audio" },
  ].filter(Boolean) as ChecklistItem[];
}

export function PostRecordChecklist({
  summary,
  onDismiss,
  onOpenExport,
}: {
  summary: PostRecordSummary;
  onDismiss: () => void;
  onOpenExport?: () => void;
}) {
  const items = checklistItems(summary);

  return (
    <div className="rounded-lg border border-signal/30 bg-signal-soft/30 p-2.5">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[12px] font-semibold text-foreground">Recording landed</p>
          <p className="text-[10px] text-muted-foreground">Here's what happened — one undo rolls it all back.</p>
        </div>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onDismiss} aria-label="Dismiss">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <ul className="mb-2 space-y-1">
        {items.map((item) => (
          <li key={item.text} className="flex gap-2 text-[11px] leading-snug">
            <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${item.done ? "text-signal" : "text-muted-foreground/40"}`} />
            <span className={item.done ? "text-foreground" : "text-muted-foreground"}>{item.text}</span>
          </li>
        ))}
      </ul>
      {summary.shapeMismatch && (
        <Button
          size="sm"
          variant="outline"
          className="mb-2 h-7 w-full text-[11px]"
          onClick={summary.shapeMismatch.onMatch}
        >
          Match canvas to this recording ({summary.shapeMismatch.width}×{summary.shapeMismatch.height})
        </Button>
      )}
      {summary.primaryScreen && (
        <div className="mb-2">
          <StylePresetQuickPick
            trackId={summary.primaryScreen.trackId}
            clipId={summary.primaryScreen.clipId}
            assetId={summary.primaryScreen.assetId}
          />
        </div>
      )}
      <div className="flex gap-1.5">
        {onOpenExport && (
          <Button size="sm" className="h-7 flex-1 text-[11px]" onClick={onOpenExport}>
            Export video
          </Button>
        )}
        <Button size="sm" variant="secondary" className="h-7 flex-1 text-[11px]" onClick={onDismiss}>
          Edit timeline
        </Button>
      </div>
    </div>
  );
}
