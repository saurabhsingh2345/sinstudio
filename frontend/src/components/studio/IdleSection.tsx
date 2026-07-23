import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../state";
import type { Asset, Clip } from "../../types";
import type { CursorSidecar } from "../../cursor";
import { getCursorTrack } from "../../cursorTracks";
import { getPeaks } from "../../peaks";
import { IDLE_DEFAULTS, detectIdle, planSpeedup, type IdleOptions } from "../../idle";
import { Section, SliderRow } from "./inspector-bits";
import { toast } from "../../toast";

/*
The pacing panel: find the stretches where nothing happened — pointer parked,
nothing pressed, nobody talking — and play them fast. Live like the silence
panel: the numbers recompute as the sliders move, and the button quotes what
it will save before it does anything.
*/
export function IdleSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const speedUpIdle = useStudio((s) => s.speedUpIdle);
  const projId = useStudio((s) => s.doc?.id);
  const [opts, setOpts] = useState<IdleOptions>(IDLE_DEFAULTS);
  const [track, setTrack] = useState<CursorSidecar | null | undefined>(undefined);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!projId) return;
    let live = true;
    getCursorTrack(projId, asset.id).then((t) => live && setTrack(t));
    getPeaks(projId, asset.id).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [projId, asset.id]);

  const plan = useMemo(() => {
    if (!track?.samples?.length || !asset.duration) return null;
    const idles = detectIdle(track.samples, track.video?.width || 0, peaks, asset.duration, opts);
    return { idles, plan: planSpeedup(clip, idles, opts.factor) };
  }, [track, peaks, asset.duration, clip, opts]);

  // No pointer track, no opinion about idleness — don't offer the panel.
  if (track === null) return null;

  return (
    <Section label="Pacing" defaultOpen={false}>
      <SliderRow
        label="Speed up"
        value={opts.factor}
        min={2}
        max={8}
        step={1}
        onChange={(v) => setOpts((o) => ({ ...o, factor: v }))}
        fmt={(v) => `${v}x`}
      />
      <SliderRow
        label="Min idle"
        value={opts.minIdle}
        min={1}
        max={6}
        step={0.5}
        onChange={(v) => setOpts((o) => ({ ...o, minIdle: v }))}
        fmt={(v) => `${v.toFixed(1)}s`}
      />
      {track === undefined ? (
        <p className="px-1 text-[10px] text-muted-foreground">Reading the pointer track…</p>
      ) : plan?.plan ? (
        <button
          onClick={() => {
            const saved = speedUpIdle(trackId, clip.id, plan.idles, opts.factor);
            if (saved > 0) toast.info(`Sped through the idle parts — ${saved.toFixed(1)}s tighter`);
          }}
          className="w-full rounded bg-brand/90 px-2 py-1.5 text-[11.5px] font-medium text-white hover:bg-brand"
        >
          Speed up {plan.plan.segments.filter((s) => s.fast).length} idle stretch
          {plan.plan.segments.filter((s) => s.fast).length === 1 ? "" : "es"} — saves {plan.plan.saved.toFixed(1)}s
        </button>
      ) : (
        <p className="px-1 text-[10px] text-muted-foreground">Nothing idle enough at these settings.</p>
      )}
    </Section>
  );
}
