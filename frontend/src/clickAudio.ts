// Preview click sounds.
//
// The export mixes a generated WAV; this plays the same shape through Web Audio
// as the playhead crosses each press, so a click sound is something you hear
// while editing rather than something you discover in the render.
//
// Approximate, like the rest of the preview — the point is timing and character,
// not sample-accuracy. The tone table mirrors clickTones in
// backend/internal/render/clicksound.go.

const TONES: Record<string, { tau: number; freq: number; noise: number }> = {
  click: { tau: 0.0045, freq: 2400, noise: 0.72 },
  tick: { tau: 0.003, freq: 4200, noise: 0.35 },
  soft: { tau: 0.009, freq: 1400, noise: 0.55 },
};

let ctx: AudioContext | null = null;

// Created lazily and only on a real playback gesture: constructing an
// AudioContext before a user interaction leaves it suspended, and browsers log
// about it.
function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

/** One short transient: a decaying tone plus a noise burst, as in the renderer. */
export function playClick(style = "click", volume = 0.35, rightButton = false) {
  const ac = audio();
  if (!ac) return;
  const tone = TONES[style] ?? TONES.click;
  const freq = tone.freq * (rightButton ? 0.78 : 1);
  const now = ac.currentTime;
  const len = tone.tau * 6;

  const gain = ac.createGain();
  gain.gain.setValueAtTime(Math.max(0, Math.min(1, volume)), now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + len);
  gain.connect(ac.destination);

  // Tonal part.
  const osc = ac.createOscillator();
  osc.frequency.setValueAtTime(freq, now);
  const oscGain = ac.createGain();
  oscGain.gain.setValueAtTime(1 - tone.noise, now);
  osc.connect(oscGain).connect(gain);
  osc.start(now);
  osc.stop(now + len);

  // Noise part — a one-shot buffer is cheaper than a live source for 5ms.
  const frames = Math.max(1, Math.ceil(len * ac.sampleRate));
  const buf = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buf;
  const noiseGain = ac.createGain();
  noiseGain.gain.setValueAtTime(tone.noise, now);
  src.connect(noiseGain).connect(gain);
  src.start(now);
}

/** Longest playhead step still treated as playback rather than a jump. */
export const MAX_STEP = 0.5;

/**
 * Which clicks the playhead just crossed.
 *
 * Bounded and forward-only on purpose, and separated from playing them so the
 * rule is testable: scrubbing backwards must not replay everything in between,
 * and a jump across the timeline must not machine-gun every click it passed.
 */
export function clicksInStep(clickTimes: number[], from: number, to: number): number[] {
  const step = to - from;
  if (step <= 0 || step > MAX_STEP) return [];
  return clickTimes.filter((t) => t > from && t <= to);
}

/** Fire clicks for the window the playhead just moved across. */
export function playClicksBetween(
  clickTimes: number[],
  from: number,
  to: number,
  style: string,
  volume: number
) {
  for (const _ of clicksInStep(clickTimes, from, to)) playClick(style, volume);
}
