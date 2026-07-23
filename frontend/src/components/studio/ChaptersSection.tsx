import { Copy, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { chaptersToYouTube, detectChapters, silencesToTimeline, type ChapterSuggestion } from "../../chapterMarkers";
import { getPeaks } from "../../peaks";
import { detectSilences, SILENCE_DEFAULTS } from "../../silence";
import { useStudio } from "../../state";
import type { Asset, Clip, EditDoc } from "../../types";
import { newId } from "../../types";
import { captionTrack } from "./bridge";
import { toast } from "../../toast";
import { useEffect, useMemo, useState } from "react";

export function ChaptersSection({ doc, projectId }: { doc: EditDoc; projectId: string }) {
  const mutate = useStudio((s) => s.mutate);
  const [chapters, setChapters] = useState<ChapterSuggestion[]>([]);
  const [busy, setBusy] = useState(false);

  const primary = useMemo(() => {
    for (const t of doc.tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips ?? []) {
        if (c.assetId && !c.title) return { trackId: t.id, clip: c, asset: doc.assets.find((a) => a.id === c.assetId) };
      }
    }
    return null;
  }, [doc]);

  const cues = captionTrack(doc)?.cues ?? [];

  const detect = async () => {
    setBusy(true);
    try {
      let timelineSilences: { t: number; duration: number }[] = [];
      if (primary?.asset && primary.clip) {
        const peaks = await getPeaks(projectId, primary.asset.id);
        if (peaks?.length) {
          const silences = detectSilences(peaks, primary.asset.duration, SILENCE_DEFAULTS);
          timelineSilences = silencesToTimeline(silences, primary.clip);
        }
      }
      const found = detectChapters(timelineSilences, cues);
      setChapters(found);
      if (!found.length) toast.info("No chapter points found — try transcribing first.");
      else toast.success(`${found.length} chapter${found.length === 1 ? "" : "s"} suggested`);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setChapters([]);
  }, [doc.id, cues.length]);

  const applyMarkers = () => {
    if (!chapters.length) return;
    mutate((d) => {
      const markers = (d.markers ||= []);
      for (const ch of chapters) {
        markers.push({
          id: newId("mk_"),
          t: ch.t,
          label: ch.label,
          color: ch.source === "pause" ? "#f4b740" : "#6366f1",
        });
      }
      markers.sort((a, b) => a.t - b.t);
    });
    toast.success(`${chapters.length} markers added to timeline`);
  };

  const copyYouTube = async () => {
    if (!chapters.length) return;
    await navigator.clipboard.writeText(chaptersToYouTube(chapters));
    toast.success("YouTube chapters copied");
  };

  return (
    <div className="space-y-2 px-3 pb-3">
      <div className="flex items-center justify-between gap-2 pt-2">
        <div>
          <p className="text-[12px] font-medium">Chapters</p>
          <p className="text-[10px] text-muted-foreground">From pauses and caption breaks</p>
        </div>
        <Button size="sm" variant="secondary" className="h-7 text-[10px]" disabled={busy} onClick={() => void detect()}>
          {busy ? "…" : "Detect"}
        </Button>
      </div>
      {chapters.length > 0 && (
        <>
          <ul className="scrollbar-thin max-h-36 space-y-1 overflow-y-auto">
            {chapters.map((ch, i) => (
              <li key={`${ch.t}-${i}`} className="flex items-center gap-2 rounded border hairline bg-panel-2/50 px-2 py-1 text-[11px]">
                <MapPin className="h-3 w-3 shrink-0 text-brand" />
                <span className="tabular text-muted-foreground">{formatTime(ch.t)}</span>
                <span className="min-w-0 truncate">{ch.label}</span>
              </li>
            ))}
          </ul>
          <div className="flex gap-1.5">
            <Button size="sm" className="h-7 flex-1 text-[10px]" onClick={applyMarkers}>
              Add markers
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" title="Copy YouTube chapter format" onClick={() => void copyYouTube()}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
