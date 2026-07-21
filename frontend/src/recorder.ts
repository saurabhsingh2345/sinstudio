// Screen/camera/mic capture, browser-side.
//
// Studio is a web app talking to a Go backend that may not even be on this
// machine (Docker, a remote host), so capture cannot be an ffmpeg screen-grab
// on the server — that would record the *server's* framebuffer, or nothing at
// all in a container. It has to originate in the tab, via getDisplayMedia, and
// upload like any other clip.
//
// Each source is recorded by its own MediaRecorder and lands as its own asset.
// One muxed file would be simpler to produce and much worse to edit: screen,
// webcam and narration want separate clips on separate tracks so their volume,
// timing and framing stay independent. Browsers also can't mux several sources
// into one MediaRecorder anyway without routing through canvas + WebAudio,
// which costs quality and CPU to produce a *less* useful result.

export type RecordKind = "screen" | "camera" | "mic";

export interface RecordOptions {
  screen: boolean;
  camera: boolean;
  mic: boolean;
  /** Tab/window audio. Chrome-only, and only offered alongside a screen share. */
  systemAudio: boolean;
  fps: number;
  micDeviceId?: string;
  cameraDeviceId?: string;
}

export interface RecordedTrack {
  kind: RecordKind;
  blob: Blob;
  filename: string;
  /** Epoch ms at which this recorder actually started — the origin cursor
   *  samples are aligned against, so it must come from onstart, not from when
   *  we asked it to start. */
  startedAt: number;
}

export interface RecordingHandle {
  /** Live streams, for previewing what is being captured. */
  preview: { screen?: MediaStream; camera?: MediaStream };
  startedAt: number;
  pause(): void;
  resume(): void;
  stop(): Promise<RecordedTrack[]>;
}

// Ordered best-first. MP4 lands first where it exists: it needs no container
// repair and plays everywhere. VP9 beats VP8 at the same bitrate; the bare
// types are last-ditch fallbacks for browsers that reject any codec string.
export const VIDEO_MIMES = [
  "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
  "video/mp4",
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
];

export const AUDIO_MIMES = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];

type SupportFn = (mime: string) => boolean;

const defaultSupport: SupportFn = (m) =>
  typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m);

/** First supported candidate, or "" to let the browser choose its own default. */
export function pickMime(candidates: string[], supported: SupportFn = defaultSupport): string {
  for (const c of candidates) {
    try {
      if (supported(c)) return c;
    } catch {
      /* isTypeSupported throws on malformed input in some browsers */
    }
  }
  return "";
}

/** Container extension for a MIME type. The backend keys off this. */
export function extForMime(mime: string, kind: RecordKind): string {
  const audioOnly = kind === "mic";
  if (mime.includes("mp4")) return audioOnly ? ".m4a" : ".mp4";
  if (mime.includes("ogg")) return audioOnly ? ".ogg" : ".ogv";
  return ".webm";
}

/** Stable, sortable, human-readable name; the clip is identified by this in the
 *  media library long after the recording session is forgotten. */
export function recordingName(kind: RecordKind, at: Date, ext: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  const stamp =
    `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${kind}-${stamp}${ext}`;
}

export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getDisplayMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

/** Mics the user has granted us the ability to see. Labels stay empty until
 *  some permission has been granted, which is why the UI offers "Default". */
export async function listInputs(): Promise<{ mics: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cameras: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: all.filter((d) => d.kind === "audioinput"),
    cameras: all.filter((d) => d.kind === "videoinput"),
  };
}

function stopStream(s?: MediaStream) {
  s?.getTracks().forEach((t) => t.stop());
}

// One recorder + its collected chunks. Kept together so stop() can resolve the
// blob only once the final dataavailable has actually landed — resolving on
// stop() alone truncates the tail of every recording.
function record(stream: MediaStream, kind: RecordKind, mimes: string[]) {
  const mime = pickMime(mimes);
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  let startedAt = 0;

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const started = new Promise<void>((resolve) => {
    rec.onstart = () => {
      startedAt = Date.now();
      resolve();
    };
  });
  const finished = new Promise<RecordedTrack | null>((resolve) => {
    rec.onstop = () => {
      const type = rec.mimeType || mime || "application/octet-stream";
      if (!chunks.length) return resolve(null);
      const blob = new Blob(chunks, { type });
      resolve({
        kind,
        blob,
        filename: recordingName(kind, new Date(startedAt || Date.now()), extForMime(type, kind)),
        startedAt,
      });
    };
  });

  // Timeslice so chunks arrive during the recording rather than as one buffer
  // at the end: a long capture otherwise sits entirely in memory, and a crash
  // loses all of it instead of the last second.
  rec.start(1000);
  return { rec, started, finished, stream };
}

export async function startRecording(opts: RecordOptions): Promise<RecordingHandle> {
  if (!isRecordingSupported()) throw new Error("This browser can't capture the screen.");
  if (!opts.screen && !opts.camera && !opts.mic) throw new Error("Pick at least one source to record.");

  let screenStream: MediaStream | undefined;
  let cameraStream: MediaStream | undefined;
  let micStream: MediaStream | undefined;

  try {
    if (opts.screen) {
      // The browser shows its own picker here; there is no way to preselect a
      // display, and the call rejects if the user cancels it.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: opts.fps } },
        audio: opts.systemAudio,
      });
    }
    if (opts.camera) {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: opts.cameraDeviceId ? { deviceId: { exact: opts.cameraDeviceId } } : true,
        audio: false,
      });
    }
    if (opts.mic) {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: opts.micDeviceId ? { deviceId: { exact: opts.micDeviceId } } : true,
        video: false,
      });
    }
  } catch (e) {
    // Never leave a granted stream running because a later one failed — the
    // camera light staying on after a failed start is alarming and looks like
    // Studio is still recording.
    stopStream(screenStream);
    stopStream(cameraStream);
    stopStream(micStream);
    throw e;
  }

  const parts = [
    screenStream && record(screenStream, "screen", VIDEO_MIMES),
    cameraStream && record(cameraStream, "camera", VIDEO_MIMES),
    micStream && record(micStream, "mic", AUDIO_MIMES),
  ].filter(Boolean) as ReturnType<typeof record>[];

  await Promise.all(parts.map((p) => p.started));
  const startedAt = Date.now();

  let stopping: Promise<RecordedTrack[]> | null = null;
  const stop = () => {
    // Idempotent: the browser's own "Stop sharing" button and our Stop button
    // both land here, often within a frame of each other.
    if (stopping) return stopping;
    stopping = (async () => {
      for (const p of parts) if (p.rec.state !== "inactive") p.rec.stop();
      const tracks = await Promise.all(parts.map((p) => p.finished));
      for (const p of parts) stopStream(p.stream);
      return tracks.filter(Boolean) as RecordedTrack[];
    })();
    return stopping;
  };

  // Chrome renders its own sharing bar with a Stop button that we don't own.
  // Without this the recording would keep "running" against a dead stream and
  // produce nothing.
  screenStream?.getVideoTracks().forEach((t) => {
    t.addEventListener("ended", () => void stop());
  });

  return {
    preview: { screen: screenStream, camera: cameraStream },
    startedAt,
    pause: () => parts.forEach((p) => p.rec.state === "recording" && p.rec.pause()),
    resume: () => parts.forEach((p) => p.rec.state === "paused" && p.rec.resume()),
    stop,
  };
}
