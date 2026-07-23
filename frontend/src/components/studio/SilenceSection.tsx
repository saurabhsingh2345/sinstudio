import { useEffect, useMemo, useState } from "react";
import { useStudio } from "../../state";
import type { Asset, Clip } from "../../types";
import { getPeaks } from "../../peaks";
import {
  SILENCE_PRESETS,
  detectSilences,
  planSilenceCuts,
  type SilenceOptions,
} from "../../silence";
import { silencesToTimeline } from "../../chapterMarkers";
import { Section, SliderRow } from "./inspector-bits";
import { toast } from "../../toast";

/*
The silence panel: detect quiet stretches in this clip, show what a cut would
save, cut on request. v2 adds preset aggressiveness and a preview list.
*/
export function SilenceSection({ trackId, clip, asset }: { trackId: string; clip: Clip; asset: Asset }) {
  const removeSilences = useStudio((s) => s.removeSilences);
  const projId = useStudio((s) => s.doc?.id);
  const [preset, setPreset] = useState<keyof typeof SILENCE_PRESETS>("normal");
  const [opts, setOpts] = useState<SilenceOptions>(SILENCE_PRESETS.normal);
  const [peaks, setPeaks] = useState<number[] | null>(null);

  useEffect(() => {
    if (!projId) return;
    let live = true;
    getPeaks(projId, asset.id).then((p) => live && setPeaks(p));
    return () => {
      live = false;
    };
  }, [projId, asset.id]);

  const applyPreset = (id: keyof typeof SILENCE_PRESETS) => {
    setPreset(id);
    setOpts(SILENCE_PRESETS[id]);
  };

  const plan = useMemo(() => {
    if (!peaks?.length || !asset.duration) return null;
    const silences = detectSilences(peaks, asset.duration, opts);
    return { silences, plan: planSilenceCuts(clip, silences), timeline: silencesToTimeline(silences, clip) };
  }, [peaks, asset.duration, clip, opts]);

  const cuts = plan?.plan ? plan.plan.kept.length - 1 + (plan.plan.kept[0].in > clip.in + 0.05 ? 1 : 0) : 0;

  return (
    <Section label="Silence" defaultOpen={false}>
      <div className="mb-2 flex gap-1">
        {(Object.keys(SILENCE_PRESETS) as (keyof typeof SILENCE_PRESETS)[]).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => applyPreset(id)}
            className={`flex-1 rounded py-1 text-[10px] capitalize ${preset === id ? "bg-brand/90 text-white" : "bg-panel-3 text-muted-foreground hover:text-foreground"}`}
          >
            {id}
          </button>
        ))}
      </div>
      <SliderRow
        label="Sensitivity"
        value={Math.round(opts.threshold * 100)}
        min={1}
        max={15}
        step={1}
        onChange={(v) => {
          setPreset("normal");
          setOpts((o) => ({ ...o, threshold: v / 100 }));
        }}
        fmt={(v) => `${v}%`}
      />
      <SliderRow
        label="Min pause"
        value={opts.minSilence}
        min={0.3}
        max={2}
        step={0.1}
        onChange={(v) => {
          setPreset("normal");
          setOpts((o) => ({ ...o, minSilence: v }));
        }}
        fmt={(v) => `${v.toFixed(1)}s`}
      />
      <SliderRow
        label="Keep edges"
        value={Math.round(opts.pad * 1000)}
        min={0}
        max={300}
        step={20}
        onChange={(v) => {
          setPreset("normal");
          setOpts((o) => ({ ...o, pad: v / 1000 }));
        }}
        fmt={(v) => `${v}ms`}
      />
      {peaks === null ? (
        <p className="px-1 text-[10px] text-muted-foreground">Reading the waveform…</p>
      ) : !peaks.length ? (
        <p className="px-1 text-[10px] text-muted-foreground">No waveform for this clip — nothing to measure.</p>
      ) : plan?.plan ? (
        <>
          {plan.timeline.length > 0 && (
            <ul className="mb-2 max-h-24 space-y-0.5 overflow-y-auto rounded border hairline bg-panel-2/40 p-1.5">
              {plan.timeline.slice(0, 8).map((s, i) => (
                <li key={i} className="text-[10px] tabular text-muted-foreground">
                  {s.t.toFixed(1)}s · {s.duration.toFixed(1)}s pause
                </li>
              ))}
              {plan.timeline.length > 8 && (
                <li className="text-[10px] text-muted-foreground">+{plan.timeline.length - 8} more</li>
              )}
            </ul>
          )}
          <button
            onClick={() => {
              const saved = removeSilences(trackId, clip.id, plan.silences);
              if (saved > 0) toast.info(`Cut the pauses — ${saved.toFixed(1)}s tighter`);
            }}
            className="w-full rounded bg-brand/90 px-2 py-1.5 text-[11.5px] font-medium text-white hover:bg-brand"
          >
            Cut {cuts > 0 ? `${cuts} pause${cuts === 1 ? "" : "s"}` : "the pauses"} — saves {plan.plan.removed.toFixed(1)}s
          </button>
        </>
      ) : (
        <p className="px-1 text-[10px] text-muted-foreground">No pauses worth cutting at these settings.</p>
      )}
    </Section>
  );
}
