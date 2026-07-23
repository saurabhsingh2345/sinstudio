/** Rec. 709 luma from sRGB bytes 0..255. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Build a 256-bin luma histogram from RGBA image data. */
export function lumaHistogram(data: Uint8ClampedArray): Uint32Array {
  const bins = new Uint32Array(256);
  for (let i = 0; i < data.length; i += 4) {
    const y = Math.min(255, Math.round(luma(data[i], data[i + 1], data[i + 2])));
    bins[y]++;
  }
  return bins;
}

/** Draw a histogram into a scope canvas (width × height). */
export function drawLumaScope(
  ctx: CanvasRenderingContext2D,
  bins: Uint32Array,
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, 0, w, h);

  let max = 1;
  for (let i = 0; i < 256; i++) if (bins[i] > max) max = bins[i];

  const pad = 4;
  const plotH = h - pad * 2;
  ctx.fillStyle = "oklch(0.78 0.16 165)"; // signal green
  for (let i = 0; i < 256; i++) {
    const barH = (bins[i] / max) * plotH;
    const x = pad + (i / 256) * (w - pad * 2);
    const bw = (w - pad * 2) / 256 + 0.6;
    ctx.fillRect(x, h - pad - barH, bw, barH);
  }

  // IRE guide lines (10%, 50%, 90%)
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  for (const ire of [0.1, 0.5, 0.9]) {
    const x = pad + ire * (w - pad * 2);
    ctx.beginPath();
    ctx.moveTo(x, pad);
    ctx.lineTo(x, h - pad);
    ctx.stroke();
  }
}

/** Flat fill colour for canvas sampling when the project bg is a CSS gradient string. */
export function solidFromBackground(bg: string): string {
  if (!bg.includes("gradient")) return bg;
  const m = bg.match(/#[0-9a-fA-F]{3,8}/);
  return m?.[0] ?? "#000000";
}
