import type { DeviceKind } from "./types";

/*
Device frame proportions — the twin of deviceSpecFor() in
backend/internal/render/device.go.

These numbers are shared for the same reason the keycap layout is: the export
pads the recording into a screen rectangle computed from them, and the preview
insets a <video> into a rectangle computed from them. If the two drift, the
preview shows the picture in a place the render does not put it — and unlike a
colour approximation, that is a lie about geometry, which the preview is never
allowed to tell. deviceLayout() is asserted against identical goldens on both
sides.
*/

export interface DeviceSpec {
  aspect: number; // outer width / outer height
  sx: number; // screen, as fractions of the device box
  sy: number;
  sw: number;
  sh: number;
  bodyRadius: number; // fraction of the device's WIDTH
  screenRadius: number;
  notch?: boolean;
  homeBar?: boolean;
  browserChrome?: boolean;
  laptopBase?: number; // fraction of device height taken by the deck
}

export const DEVICE_SPECS: Record<DeviceKind, DeviceSpec> = {
  browser: {
    aspect: 1.62,
    sx: 0.008,
    sy: 0.082,
    sw: 0.984,
    sh: 0.893,
    bodyRadius: 0.012,
    screenRadius: 0.004,
    browserChrome: true,
  },
  phone: {
    aspect: 0.49,
    sx: 0.043,
    sy: 0.021,
    sw: 0.914,
    sh: 0.958,
    bodyRadius: 0.13,
    screenRadius: 0.1,
    notch: true,
    homeBar: true,
  },
  tablet: {
    aspect: 0.75,
    sx: 0.055,
    sy: 0.042,
    sw: 0.89,
    sh: 0.916,
    bodyRadius: 0.05,
    screenRadius: 0.035,
  },
  laptop: {
    // Screen aspect ≈1.72, near enough to 16:9 that a normal recording only
    // letterboxes by a few pixels.
    aspect: 1.55,
    sx: 0.07,
    sy: 0.037,
    sw: 0.86,
    sh: 0.775,
    bodyRadius: 0.018,
    screenRadius: 0.012,
    laptopBase: 0.115,
  },
};

export const DEVICE_KINDS: { kind: DeviceKind; label: string }[] = [
  { kind: "browser", label: "Browser window" },
  { kind: "laptop", label: "Laptop" },
  { kind: "phone", label: "Phone" },
  { kind: "tablet", label: "Tablet" },
];

export const DEVICE_COLOR = "#1b1d21";

export function deviceSpec(kind: string): DeviceSpec {
  return DEVICE_SPECS[kind as DeviceKind] ?? DEVICE_SPECS.browser;
}

/** Matches even() in device.go — 4:2:0 has no representation for odd targets. */
function even(v: number): number {
  let n = Math.trunc(v);
  if (n % 2 !== 0) n -= 1;
  return n < 2 ? 2 : n;
}

export interface DeviceBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The device's outer box on the canvas. Mirrors deviceBox() in device.go. */
export function deviceBox(kind: string, canvasW: number, canvasH: number): DeviceBox {
  const spec = deviceSpec(kind);
  const margin = 0.94;
  const fw = canvasW * margin;
  const fh = canvasH * margin;
  let w: number;
  let h: number;
  if (fw / fh > spec.aspect) {
    h = fh;
    w = h * spec.aspect;
  } else {
    w = fw;
    h = w / spec.aspect;
  }
  return { x: (canvasW - w) / 2, y: (canvasH - h) / 2, w, h };
}

/**
 * The screen opening in canvas pixels — where the recording goes.
 *
 * Rounded exactly as the renderer rounds it, so the preview insets the video
 * into the same rectangle the export pads it into.
 */
export function deviceLayout(kind: string, canvasW: number, canvasH: number): DeviceBox {
  const spec = deviceSpec(kind);
  const b = deviceBox(kind, canvasW, canvasH);
  return {
    x: even(b.x + spec.sx * b.w),
    y: even(b.y + spec.sy * b.h),
    w: even(spec.sw * b.w),
    h: even(spec.sh * b.h),
  };
}

/** A new frame, defaulting to the one a tutorial most often wants. */
export function newDevice(kind: DeviceKind = "browser") {
  return { kind, color: DEVICE_COLOR };
}
