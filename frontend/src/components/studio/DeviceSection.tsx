import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStudio } from "../../state";
import type { Clip, DeviceKind } from "../../types";
import { DEVICE_COLOR, DEVICE_KINDS, deviceLayout, newDevice } from "../../device";
import { ColorSwatch, Field, Section } from "./inspector-bits";

/*
The device frame panel.

Deliberately only two controls. A mockup generator invites endless options —
bezel width, corner radius, shadow depth — and none of them change whether the
tutorial reads. Pick the device and pick the colour; the proportions are the
device's, not a preference.
*/
export function DeviceSection({ trackId, clip }: { trackId: string; clip: Clip }) {
  const updateClip = useStudio((s) => s.updateClip);
  const doc = useStudio((s) => s.doc);
  const dev = clip.device;

  const canvas = doc?.canvas;
  const screen = dev && canvas ? deviceLayout(dev.kind, canvas.width, canvas.height) : null;

  return (
    <Section label="Device frame" defaultOpen={!!dev}>
      <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1">
        <input
          type="checkbox"
          checked={!!dev}
          onChange={(e) => updateClip(trackId, clip.id, { device: e.target.checked ? newDevice() : undefined })}
          className="accent-brand"
        />
        <span className="text-[11.5px]">Put the picture in a device</span>
      </label>

      {dev && (
        <>
          <Field label="Device">
            <Select
              value={dev.kind}
              onValueChange={(v) => updateClip(trackId, clip.id, { device: { ...dev, kind: v as DeviceKind } })}
            >
              <SelectTrigger className="h-7 bg-panel-2 text-[12px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICE_KINDS.map((k) => (
                  <SelectItem key={k.kind} value={k.kind}>
                    {k.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Body">
            <ColorSwatch
              color={dev.color || DEVICE_COLOR}
              onChange={(color) => updateClip(trackId, clip.id, { device: { ...dev, color } })}
            />
          </Field>
          {screen && (
            // The real screen size, so a mismatch with the footage is visible
            // here rather than as unexplained black bars in the export.
            <p className="text-[10px] leading-snug text-muted-foreground">
              Screen is <span className="tabular">{screen.w}×{screen.h}</span>. The picture is fitted inside it, so a
              different shape letterboxes rather than stretches.
            </p>
          )}
        </>
      )}
    </Section>
  );
}
