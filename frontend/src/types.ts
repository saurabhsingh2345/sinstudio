// Mirror of backend/internal/schema/schema.go — keep in sync.

export type TrackKind = "background" | "video" | "overlay" | "audio" | "caption";

export interface Transform {
  x: number;
  y: number;
  scale: number;
  opacity: number;
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

// Effects: per-clip color/blur adjustments. Identity = brightness 0, contrast 1,
// saturation 1, hue 0, blur 0.
export interface Effects {
  brightness?: number; // -1..1
  contrast?: number; // 0..2
  saturation?: number; // 0..3
  hue?: number; // degrees
  blur?: number; // sigma px
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
  keyframes?: Record<string, Keyframe[]>; // property ("x"|"y"|"scale"|"opacity") -> control points
  effects?: Effects;
  title?: Title; // when set, this is a text clip (no asset)
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
  thumbnail?: string;
  source: string;
  createdAt: string;
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

export interface GeneratorStatus {
  id: string;
  name: string;
  description: string;
  inputKind: string;
  outputExt: string;
  params: ParamSpec[];
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
  progress: number;
  message?: string;
  data?: any;
  at: string;
}

export const mediaUrl = (rel?: string) => (rel ? `/media/${rel}` : "");
export const newId = (p: string) =>
  p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// clipPlayDur is the on-timeline length of a clip after speed scaling — mirrors
// schema.Clip.PlayDur in Go. Use this anywhere a clip's timeline end is needed
// (end = clip.start + clipPlayDur(clip)); trimming with speed != 1 makes the
// timeline footprint differ from the raw source span (out - in).
export const clipPlayDur = (c: Clip): number => {
  const sp = c.speed && c.speed > 0 ? c.speed : 1;
  const d = (c.out - c.in) / sp;
  return d > 0 ? d : 0;
};
