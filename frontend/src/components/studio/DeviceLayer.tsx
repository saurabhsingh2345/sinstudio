import { deviceBox, deviceSpec, DEVICE_COLOR } from "../../device";
import type { DeviceFrame } from "../../types";

/*
The preview twin of backend/internal/render/device.go.

Drawn as SVG in a canvas-sized viewBox, so every number here is the same canvas
pixel the Go renderer computes with — the two cannot drift through a unit
conversion. Both halves take their proportions from the shared spec in
device.ts, and the screen rectangle is asserted identical on each side.

The frame's shapes are an approximation of the rendered ones, as the preview
always is. Its GEOMETRY is not: the opening has to sit exactly where the export
pads the picture, or the editor is showing the recording somewhere it will not
be.
*/
export function DeviceLayer({
  device,
  canvasW,
  canvasH,
}: {
  device: DeviceFrame;
  canvasW: number;
  canvasH: number;
}) {
  const spec = deviceSpec(device.kind);
  const b = deviceBox(device.kind, canvasW, canvasH);
  const body = device.color || DEVICE_COLOR;

  const sx = b.x + spec.sx * b.w;
  const sy = b.y + spec.sy * b.h;
  const sw = spec.sw * b.w;
  const sh = spec.sh * b.h;

  // A mask rather than an even-odd path: two <rect>s with their own corner radii
  // stay readable, and SVG has no way to express a rounded hole in a rounded
  // rect as one path without hand-writing the arcs.
  const maskId = `dev-hole-${device.kind}`;
  const barH = spec.sy * b.h;
  const deckTop = b.y + b.h * (1 - (spec.laptopBase ?? 0));

  return (
    <svg
      viewBox={`0 0 ${canvasW} ${canvasH}`}
      preserveAspectRatio="none"
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }}
    >
      <defs>
        <mask id={maskId}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={spec.bodyRadius * b.w} fill="white" />
          <rect x={sx} y={sy} width={sw} height={sh} rx={spec.screenRadius * b.w} fill="black" />
        </mask>
      </defs>

      <g mask={`url(#${maskId})`}>
        <rect x={b.x} y={b.y} width={b.w} height={b.h} rx={spec.bodyRadius * b.w} fill={body} />
        {spec.laptopBase ? (
          <rect x={b.x} y={deckTop} width={b.w} height={b.y + b.h - deckTop} fill={lighten(body, 12)} />
        ) : null}
      </g>

      {spec.browserChrome && (
        <>
          {["#ff5f57", "#ffbd2e", "#27c93f"].map((c, i) => (
            <circle key={c} cx={b.x + barH * (0.55 + i * 0.42)} cy={b.y + barH * 0.5} r={Math.max(2, barH * 0.13)} fill={c} />
          ))}
          <rect
            x={b.x + barH * 2.3}
            y={b.y + barH * 0.5 - (barH * 0.46) / 2}
            width={b.w * 0.72 - barH * 2.3}
            height={barH * 0.46}
            rx={(barH * 0.46) / 2}
            fill={lighten(body, 26)}
          />
        </>
      )}

      {spec.laptopBase ? (
        <rect
          x={b.x + b.w / 2 - (b.w * 0.12) / 2}
          y={deckTop - (b.h * spec.laptopBase * 0.3) / 2}
          width={b.w * 0.12}
          height={b.h * spec.laptopBase * 0.3}
          rx={(b.h * spec.laptopBase * 0.3) / 2}
          fill={lighten(body, 34)}
        />
      ) : null}

      {/* Drawn after the mask, because on a phone the camera cut-out genuinely
          sits inside the screen area rather than in the bezel around it. */}
      {spec.notch && (
        <rect
          x={b.x + b.w / 2 - (b.w * 0.34) / 2}
          y={b.y + b.h * 0.032 - (b.h * 0.021) / 2}
          width={b.w * 0.34}
          height={b.h * 0.021}
          rx={(b.h * 0.021) / 2}
          fill={body}
        />
      )}
      {spec.homeBar && (
        <rect
          x={b.x + b.w / 2 - (b.w * 0.3) / 2}
          y={b.y + b.h * 0.978}
          width={b.w * 0.3}
          height={Math.max(3, b.h * 0.007)}
          rx={Math.max(1.5, b.h * 0.0035)}
          fill="rgba(255,255,255,0.6)"
        />
      )}
    </svg>
  );
}

/** Mirrors lighten() in device.go — the highlights that keep a flat slab from
 *  reading as a hole. */
function lighten(hex: string, by: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.min(255, v + by));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
