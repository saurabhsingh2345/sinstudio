// Mirror of backend/internal/schema/schema.go — keep in sync.

export type TrackKind = "background" | "video" | "overlay" | "audio" | "caption";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation?: number; // clockwise degrees about the clip's center
  // The zoom origin — the point scaling holds fixed — relative to the clip's
  // center, where ±0.5 is an edge and 0 (the default) is the center. Stored
  // center-relative so documents predating anchors still zoom from the middle.
  anchorX?: number;
  anchorY?: number;
}

// Properties that can be keyframed. A keyed property overrides the matching
// static Transform field for the clip's life.
export const KEYABLE = ["x", "y", "scale", "rotation", "opacity"] as const;
export type Keyable = (typeof KEYABLE)[number];

// anchorFrac converts a center-relative anchor to a 0..1 box fraction (0.5 =
// center). Mirrors schema.Transform.AnchorFrac.
export const anchorFrac = (t: Transform): [number, number] => {
  const f = (v: number | undefined) => Math.max(0, Math.min(1, (v ?? 0) + 0.5));
  return [f(t.anchorX), f(t.anchorY)];
};

// Cursor emphasis for a screen recording. Only does anything when the clip's
// asset has a recorded pointer track beside it; inert on any other clip.
export interface CursorHighlight {
  size?: number; // diameter in canvas px
  color?: string;
  opacity?: number; // 0..1
}
export interface CursorClicks {
  size?: number; // final ring diameter in canvas px
  color?: string;
  duration?: number; // seconds per ring
}
export interface CursorSpotlight {
  radius?: number; // clear radius in canvas px
  dim?: number; // 0..1 darkness outside it
}
export interface CursorPointer {
  size?: number;
  opacity?: number; // 0..1
  style?: string; // arrow | dot | ring
  color?: string;
  smoothing?: number; // 0..1
}
export interface CursorClickSound {
  volume?: number; // 0..1
  style?: string; // click | tick | soft
}
export interface CursorFX {
  highlight?: CursorHighlight;
  clicks?: CursorClicks;
  spotlight?: CursorSpotlight;
  /** An audible click at each press. Independent of the visual rings. */
  sound?: CursorClickSound;
  /** Studio's own drawn cursor — only for recordings captured without one. */
  pointer?: CursorPointer;
}

// Transition types: fade | dissolve | slide-left | slide-right | slide-top | slide-bottom
export interface Transition {
  type: string;
  duration: number; // seconds
}

// Keyframe: a property's value at clip-local time t (seconds from clip start).
// ease names the curve for the segment from this keyframe to the next ("" = linear).
export interface Keyframe {
  t: number;
  value: number;
  ease?: string;
}

// Title: a text-clip spec (clip has no asset when set).
export type TitleAnim = "none" | "fade" | "fadeUp" | "pop" | "slide" | "zoom";
export type TitleReveal = "" | "typewriter" | "word";

export interface Title {
  text: string;
  size: number; // px at 1080 reference
  color: string; // hex
  align?: "left" | "center" | "right";
  posY: number; // 0..1
  background?: string; // hex band, "" = none
  bold?: boolean;
  anim?: TitleAnim; // entrance/exit preset (motion lives in keyframes/transitions)
  reveal?: TitleReveal; // per-word/character text build-on (renderer-composited)
}

// Redaction: a blurred/pixelated region of a clip's own picture.
// Mirrors backend/internal/schema Redaction — keep the two in step.
export type RedactKind = "blur" | "pixelate";

export interface Redaction {
  kind: RedactKind;
  // Fractions of THE CLIP'S OWN FRAME (0..1), not of the canvas — which is what
  // makes a redaction stick to the thing it hides when the clip is zoomed.
  x: number;
  y: number;
  w: number;
  h: number;
  amount?: number; // 0..1 strength (0 = unset)
}

// Annotation: a callout shape drawn over the video (clip has no asset when set).
// Mirrors backend/internal/schema Annotation — keep the two in step.
export type AnnoKind = "arrow" | "box" | "ellipse" | "highlight" | "number" | "text" | "keys";

export interface Annotation {
  kind: AnnoKind;
  // Canvas fractions (0..1), not pixels, so a callout keeps its place at any
  // export size. For an arrow (x,y) is the tail and (x2,y2) the point; for every
  // other kind they are the bounding box.
  x: number;
  y: number;
  w?: number;
  h?: number;
  x2?: number;
  y2?: number;
  color?: string; // stroke/shape colour
  fill?: string; // interior; "" = hollow
  thickness?: number; // px at 1080 reference
  opacity?: number; // 0..1
  radius?: number; // corner rounding, px at 1080 reference
  text?: string;
  textSize?: number; // px at 1080 reference
  textColor?: string;
}

// Effects: per-clip color/blur adjustments. Identity = brightness 0, contrast 1,
// saturation 1, hue 0, blur 0.
export interface Effects {
  brightness?: number; // -1..1
  contrast?: number; // 0..2
  saturation?: number; // 0..3
  hue?: number; // degrees
  blur?: number; // sigma px
}

// AudioEQ: 3-band equalizer gains in dB (roughly -12..+12; 0 = flat).
export interface AudioEQ {
  low?: number; // ≈100 Hz shelf
  mid?: number; // ≈1 kHz peak
  high?: number; // ≈8 kHz shelf
}

export interface Clip {
  id: string;
  assetId: string;
  start: number; // timeline position (s)
  in: number; // source in (s)
  out: number; // source out (s)
  transform: Transform;
  volume: number;
  speed?: number; // playback rate (1 = normal)
  fadeIn?: number; // seconds
  fadeOut?: number; // seconds
  transitionIn?: Transition;
  transitionOut?: Transition;
  keyframes?: Record<string, Keyframe[]>; // Keyable property -> control points
  cursor?: CursorFX; // pointer emphasis, only for clips with a recorded pointer track
  effects?: Effects;
  eq?: AudioEQ; // 3-band audio equalizer
  lut?: string; // .cube color LUT filename (in the project's luts dir)
  mute?: boolean; // silence this clip's own audio (used after detaching audio)
  hold?: number; // seconds of frozen last frame appended after the source plays out
  sourceClip?: string; // detached audio clip → the video clip it came from (UI grouping)
  disabled?: boolean; // excluded from render/preview without deleting (per-clip enable toggle)
  title?: Title; // when set, this is a text clip (no asset)
  annotation?: Annotation; // when set, this is a callout clip (no asset)
  redactions?: Redaction[]; // blurred/pixelated regions of this clip's picture
}

export interface ExportOptions {
  preset?: "" | "shorts" | "square" | "4k" | "portrait4k";
  format?: "" | "mp4" | "webm" | "gif" | "mov";
  from?: number;
  to?: number;
  fps?: number;
  loudnorm?: boolean; // EBU R128 loudness normalization on the final mix
}

export interface LibrarySource {
  id: string;
  name: string;
  dir: string;
}

export interface LibraryEntry {
  id: string;
  name: string;
  source: string;
  path: string;
  ext: string;
  size: number;
  modTime: string;
}

export interface CaptionStyle {
  font: string;
  size: number;
  color: string;
  align: string;
  posY: number;
}

export interface CaptionCue {
  id: string;
  start: number;
  end: number;
  text: string;
  style: CaptionStyle;
}

export interface Track {
  id: string;
  kind: TrackKind;
  name?: string;
  clips?: Clip[];
  cues?: CaptionCue[];
  backgroundColor?: string;
  muted?: boolean;
  hidden?: boolean;
  solo?: boolean;
  duck?: boolean; // audio lane: auto-duck under voice (music/bed)
}

export interface Asset {
  id: string;
  name: string;
  kind: "video" | "audio" | "image";
  path: string;
  duration: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  hasAudio?: boolean; // undefined = not yet probed; false = silent (no audio stream)
  thumbnail?: string;
  source: string;
  createdAt: string;
  // Generation provenance — present on assets produced by a generator plugin so
  // they stay "live" and re-renderable. genInput is the generator input (e.g.
  // the FunkyCode scenes JSON); genParams are the CLI flag values. source doubles
  // as the generator id for generated assets.
  genInput?: string;
  genParams?: Record<string, string>;
  // True when a pointer track arrived beside the media, i.e. this is a screen
  // recording cursor effects can be drawn on.
  hasCursor?: boolean;
  // True when the OS cursor was kept out of the capture, so Studio owns drawing
  // it — and only then can it be resized, restyled or smoothed.
  cursorHidden?: boolean;
}

export interface Canvas {
  width: number;
  height: number;
  fps: number;
}

export interface Marker {
  id: string;
  t: number; // seconds
  label?: string;
  color?: string;
}

export interface EditDoc {
  id: string;
  name: string;
  version: number;
  canvas: Canvas;
  tracks: Track[];
  assets: Asset[];
  markers?: Marker[];
  updated?: string;
}

export interface ParamSpec {
  flag: string;
  label: string;
  type: "string" | "bool" | "enum";
  default?: string;
  options?: string[];
}

// FieldSpec describes one editable property of a generator's input document.
// It is a *view* over the document, not a model of it: the editor touches only
// the paths named here and leaves everything else intact, so a generator can
// carry properties Studio doesn't know about without them being destroyed.
export interface FieldSpec {
  path: string; // dot path, with one optional "[]" array hop: "scenes[].code"
  label: string;
  type: "string" | "text" | "number" | "bool" | "enum" | "array";
  default?: unknown;
  options?: string[];
  hint?: string;
  mono?: boolean; // render as a monospace code editor
  fields?: FieldSpec[]; // for type "array": the shape of each item
  itemOf?: string; // for type "array": singular label, e.g. "Scene"
}

// How a generator renders a cheap, throwaway version of a clip while its
// properties are being edited. Absent when the generator has no cheaper mode —
// the editor then says so rather than pretending.
export interface PreviewSpec {
  params?: Record<string, string>;
  note?: string;
}

export interface GeneratorStatus {
  id: string;
  name: string;
  description: string;
  inputKind: string;
  outputExt: string;
  params: ParamSpec[];
  // Empty when the generator publishes no schema: the document is then edited
  // raw, in the format rawKind names.
  fields?: FieldSpec[];
  docRoot?: "object" | "array";
  preview?: PreviewSpec;
  rawKind?: "json" | "text" | "html";
  available: boolean;
  buildHint?: string;
}

export type AppState = "stopped" | "running" | "exited";

export interface AppStatus {
  id: string;
  name: string;
  description?: string;
  cwd: string;
  command: string[];
  url?: string;
  state: AppState;
  pid?: number;
  uptime?: string;
  healthy: boolean;
  message?: string;
}

export interface JobEvent {
  jobId: string;
  kind: string;
  type: "progress" | "log" | "done" | "error";
  status?: "queued" | "running" | "done" | "error" | "canceled";
  progress: number;
  message?: string;
  data?: any;
  at: string;
}

export interface RenderEntry {
  name: string;
  url: string;
  size: number;
  created: string;
}

// mediaUrl builds a URL under the media root. Pass `v` (a version token that
// changes when the file is rewritten in place — e.g. a re-rendered asset's
// createdAt) to cache-bust: re-render overwrites the SAME path, so without a
// changing query the browser keeps serving the stale cached video/thumbnail.
export const mediaUrl = (rel?: string, v?: string | number) =>
  rel ? `/media/${rel}${v != null && v !== "" ? `?v=${encodeURIComponent(String(v))}` : ""}` : "";
export const newId = (p: string) =>
  p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// clipPlayDur is the on-timeline length of a clip after speed scaling — mirrors
// schema.Clip.PlayDur in Go. Use this anywhere a clip's timeline end is needed
// (end = clip.start + clipPlayDur(clip)); trimming with speed != 1 makes the
// timeline footprint differ from the raw source span (out - in).
export const clipPlayDur = (c: Clip): number => {
  const sp = c.speed && c.speed > 0 ? c.speed : 1;
  const d = (c.out - c.in) / sp;
  const hold = c.hold && c.hold > 0 ? c.hold : 0;
  return (d > 0 ? d : 0) + hold;
};

// clipSrcDur is the played length of the source span only (no hold) — the point
// on the timeline where the video content ends and the frozen last frame begins.
export const clipSrcDur = (c: Clip): number => {
  const sp = c.speed && c.speed > 0 ? c.speed : 1;
  const d = (c.out - c.in) / sp;
  return d > 0 ? d : 0;
};

// A plugin manifest that failed to load. Loading is non-fatal, so these are
// reported rather than thrown — a plugin nobody can see is worse than a visible
// error.
export interface PluginLoadError {
  path: string;
  error: string;
}

export interface PluginState {
  dir: string;
  errors: PluginLoadError[];
}
