import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../state";
import type { Asset, Clip } from "../../types";
import { getPeaks } from "../../peaks";
import { SILENCE_DEFAULTS, detectSilences, planSilenceCuts, type SilenceOptions } from "../../silence";
import { Section, SliderRow } from "./inspector-bits";
import { toast } from "../../toast";

/*
The silence panel: detect quiet stretches in this clip, show what a cut would
save, cut on request.

Detection is live — it recomputes as the sliders move, against the SAME peaks
the timeline draws — so "3 pauses, saves 4.2s" updates while you tune, and the
button says exactly what it will do before it does it. The cut itself is one
store action and one undo.
*/
export function SilenceSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const removeSilences = useStudio((s) => s.removeSilences);
  const projId = useStudio((s) => s.doc?.id);
  const [opts, setOpts] = useState<SilenceOptions>(SILENCE_DEFAULTS);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!projId) return;
    let live = true;
    getPeaks(projId, asset.id).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [projId, asset.id]);

  const plan = useMemo(() => {
    if (!peaks?.length || !asset.duration) return null;
    const silences = detectSilences(peaks, asset.duration, opts);
    return { silences, plan: planSilenceCuts(clip, silences) };
  }, [peaks, asset.duration, clip, opts]);

  const cuts = plan?.plan ? plan.plan.kept.length - 1 + (plan.plan.kept[0].in > clip.in + 0.05 ? 1 : 0) : 0;

  return (
    <Section label="Silence" defaultOpen={false}>
      <SliderRow
        label="Sensitivity"
        value={Math.round(opts.threshold * 100)}
        min={1}
        max={15}
        step={1}
        onChange={(v) => setOpts((o) => ({ ...o, threshold: v / 100 }))}
        fmt={(v) => `${v}%`}
      />
      <SliderRow
        label="Min pause"
        value={opts.minSilence}
        min={0.3}
        max={2}
        step={0.1}
        onChange={(v) => setOpts((o) => ({ ...o, minSilence: v }))}
        fmt={(v) => `${v.toFixed(1)}s`}
      />
      <SliderRow
        label="Keep edges"
        value={Math.round(opts.pad * 1000)}
        min={0}
        max={300}
        step={20}
        onChange={(v) => setOpts((o) => ({ ...o, pad: v / 1000 }))}
        fmt={(v) => `${v}ms`}
      />
      {peaks === null ? (
        <p className="px-1 text-[10px] text-muted-foreground">Reading the waveform…</p>
      ) : !peaks.length ? (
        <p className="px-1 text-[10px] text-muted-foreground">No waveform for this clip — nothing to measure.</p>
      ) : plan?.plan ? (
        <button
          onClick={() => {
            const saved = removeSilences(trackId, clip.id, plan.silences);
            if (saved > 0) toast.info(`Cut the pauses — ${saved.toFixed(1)}s tighter`);
          }}
          className="w-full rounded bg-brand/90 px-2 py-1.5 text-[11.5px] font-medium text-white hover:bg-brand"
        >
          Cut {cuts > 0 ? `${cuts} pause${cuts === 1 ? "" : "s"}` : "the pauses"} — saves {plan.plan.removed.toFixed(1)}s
        </button>
      ) : (
        <p className="px-1 text-[10px] text-muted-foreground">No pauses worth cutting at these settings.</p>
      )}
    </Section>
  );
}
