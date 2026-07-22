import { useStudio } from "../../state";
import type { Backdrop, Clip } from "../../types";
import { BACKDROP_DEFAULTS, BACKDROP_PRESETS, backdropCSS } from "../../backdrop";
import { ColorSwatch, Field, Section, SliderRow } from "./inspector-bits";

/*
The backdrop panel — wallpaper, inset, corner radius, shadow.

Presets first, controls second: the point of a backdrop is to look produced in
one click, and six good gradients cover almost every video. The sliders exist
for the video that has a brand colour to hit.
*/
export function BackdropSection({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const bd = clip.backdrop;

  const patch = (p: Partial<Backdrop>) => updateClip(trackId, clip.id, { backdrop: { ...(bd ?? {}), ...p } });

  return (
    <Section label="Backdrop" defaultOpen={!!bd}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1">
        <input
          type="checkbox"
          checked={!!bd}
          onChange={(e) =>
            updateClip(trackId, clip.id, {
              // Enabling starts on the first preset rather than an empty
              // object, so the very first click already looks like something.
              backdrop: e.target.checked
                ? { color1: BACKDROP_PRESETS[0].color1, color2: BACKDROP_PRESETS[0].color2 }
                : undefined,
            })
          }
          className="accent-brand"
        />
        <span className="text-[11.5px]">Scene behind the picture</span>
      </label>

      {bd && (
        <>
          <div className="flex flex-wrap gap-1.5 px-1 pb-1">
            {BACKDROP_PRESETS.map((p) => (
              <button
                key={p.name}
                title={p.name}
                onClick={() => patch({ color1: p.color1, color2: p.color2 })}
                className="h-6 w-9 rounded border hairline"
                style={{ background: backdropCSS({ color1: p.color1, color2: p.color2 }) }}
              />
            ))}
          </div>
          <Field label="Top">
            <ColorSwatch color={bd.color1 || BACKDROP_DEFAULTS.color1} onChange={(color1) => patch({ color1 })} />
          </Field>
          <Field label="Bottom">
            <ColorSwatch color={bd.color2 || bd.color1 || BACKDROP_DEFAULTS.color1} onChange={(color2) => patch({ color2 })} />
          </Field>
          <SliderRow
            label="Padding"
            value={Math.round((bd.inset || BACKDROP_DEFAULTS.inset) * 100)}
            min={2}
            max={35}
            step={1}
            onChange={(v) => patch({ inset: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          <SliderRow
            label="Corners"
            value={bd.radius || BACKDROP_DEFAULTS.radius}
            min={0}
            max={60}
            step={2}
            onChange={(v) => patch({ radius: v })}
            fmt={(v) => `${v}px`}
          />
          <SliderRow
            label="Shadow"
            value={Math.round((bd.shadow || BACKDROP_DEFAULTS.shadow) * 100)}
            min={0}
            max={100}
            step={5}
            onChange={(v) => patch({ shadow: v / 100 })}
            fmt={(v) => `${v}%`}
          />
          {clip.device && (
            <p className="text-[10px] leading-snug text-muted-foreground">
              With a device frame, the wallpaper applies — the device brings its own body and shadow.
            </p>
          )}
        </>
      )}
    </Section>
  );
}
