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

import {
  cropStream,
  isRegionRecordingSupported,
  isWholeFrame,
  type CroppedStream,
  type Region,
} from "./region";

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
  /**
   * Keep the OS cursor out of the capture so Studio can draw its own.
   *
   * This is what makes the cursor editable at all — smoothing, resizing,
   * restyling and magnifying are only possible when the pixels don't already
   * contain a cursor we can't move. Only ask for it when pointer tracking is
   * actually running, or the recording ends up with no cursor whatsoever.
   */
  hideCursor?: boolean;
  /**
   * Record only this rectangle of the shared surface, in fractions of it.
   *
   * Whole-frame or absent means no cropping at all, and the stream goes to the
   * recorder untouched — the cropping pipeline is not built at all in that case,
   * so the common path keeps the display track's own frames.
   */
  region?: Region;
  /**
   * A display stream already granted by the caller.
   *
   * Region picking needs the share to exist before the region can be drawn on
   * it, so the panel acquires the stream, lets the user drag a rectangle over a
   * live preview of it, and then starts recording with the same stream. Without
   * this, picking a region would mean two trips through the browser's picker.
   */
  screenStream?: MediaStream;
}

export interface RecordedTrack {
  kind: RecordKind;
  blob: Blob;
  filename: string;
  /** Epoch ms at which this recorder actually started — the origin cursor
   *  samples are aligned against, so it must come from onstart, not from when
   *  we asked it to start. */
  startedAt: number;
  /** Captured frame size, for placing cursor coordinates. Absent for audio. */
  video?: { width: number; height: number };
  /** "monitor" | "window" | "browser" for a display capture. Only a whole-monitor
   *  capture can be mapped to screen-space pointer coordinates. */
  surface?: string;
  /** True when the OS cursor was verifiably kept out of the capture, so the
   *  renderer should draw one. Read back from the track rather than assumed
   *  from what we asked for — see hideCursor in RecordOptions. */
  cursorHidden?: boolean;
  /** Set when only a region was recorded: the crop that was applied, in the
   *  full frame's pixels. Pointer samples are still whole-screen, so they need
   *  this to be placed — see toSidecar. */
  crop?: { frame: { width: number; height: number }; x: number; y: number };
}

export interface RecordingHandle {
  /** Live streams, for previewing what is being captured. */
  preview: { screen?: MediaStream; camera?: MediaStream };
  startedAt: number;
  /** Set by the caller when the cursor helper is recording alongside this
   *  session, so stopping knows whether there is anything to collect. */
  cursorTracking?: boolean;
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
/**
 * Whether the OS cursor is verifiably absent from a display track.
 *
 * Asking for cursor:"never" is not the same as getting it — the constraint is
 * optional in the spec and browsers differ. Getting this wrong in either
 * direction is visible: believe it worked when it didn't and the export has two
 * cursors; believe it failed when it worked and the export has none. So this
 * only returns true on a positive confirmation from the track itself, and
 * treats "the browser won't say" as not hidden.
 */
export function cursorIsHidden(track: MediaStreamTrack | undefined): boolean {
  const s = track?.getSettings?.() as (MediaTrackSettings & { cursor?: string }) | undefined;
  return s?.cursor === "never";
}

/**
 * Frame geometry read off a live track.
 *
 * Only valid while the track is running: once it stops, settings are gone and
 * there is no way to learn what was actually captured.
 */
export function trackFrameSize(track: MediaStreamTrack | undefined): { width: number; height: number } | undefined {
  const s = track?.getSettings?.();
  return s?.width && s?.height ? { width: s.width, height: s.height } : undefined;
}

function record(
  stream: MediaStream,
  kind: RecordKind,
  mimes: string[],
  meta?: { frame?: { width: number; height: number }; surface?: string; cursorHidden?: boolean; crop?: RecordedTrack["crop"] }
) {
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
  // Read the frame geometry while the track is live; once stopped, settings
  // are gone and there is no way to learn what was actually captured.
  //
  // A cropped stream carries a generated track, which knows nothing about the
  // display it came from — surface and cursor state have to be read from the
  // original share and handed in, or a region recording would look like a
  // window share and silently lose its cursor data.
  const vtrack = stream.getVideoTracks()[0];
  const settings = vtrack?.getSettings?.() as (MediaTrackSettings & { displaySurface?: string }) | undefined;
  const video =
    meta?.frame ??
    (settings?.width && settings?.height ? { width: settings.width, height: settings.height } : undefined);
  const surface = meta?.surface ?? settings?.displaySurface;
  const hidden = kind === "screen" ? (meta?.cursorHidden ?? cursorIsHidden(vtrack)) : undefined;

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
        video,
        surface,
        cursorHidden: hidden,
        crop: meta?.crop,
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
      // Reuse a share the caller already has — region picking needs the stream
      // to exist before the region can be drawn on it.
      screenStream =
        opts.screenStream ??
        // The browser shows its own picker here; there is no way to preselect a
        // display, and the call rejects if the user cancels it.
        (await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: { ideal: opts.fps },
            // Not universally supported, and browsers may quietly ignore it —
            // which is why what actually happened is read back below rather than
            // inferred from having asked.
            ...(opts.hideCursor ? { cursor: "never" } : {}),
          } as MediaTrackConstraints,
          audio: opts.systemAudio,
        }));
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

  // Crop before recording, if a region was chosen. Everything the recorder
  // needs to know about the share is read from the ORIGINAL track first, since
  // the cropped stream carries a generated one that knows none of it.
  let cropped: CroppedStream | undefined;
  let screenMeta: Parameters<typeof record>[3];
  if (screenStream) {
    const src = screenStream.getVideoTracks()[0];
    const settings = src?.getSettings?.() as (MediaTrackSettings & { displaySurface?: string }) | undefined;
    const frame = trackFrameSize(src);
    screenMeta = { frame, surface: settings?.displaySurface, cursorHidden: cursorIsHidden(src) };

    if (opts.region && !isWholeFrame(opts.region) && frame) {
      if (!isRegionRecordingSupported()) {
        stopStream(screenStream);
        stopStream(cameraStream);
        stopStream(micStream);
        throw new Error("This browser can't record a region. Chrome or Edge can.");
      }
      cropped = cropStream(screenStream, opts.region, frame.width, frame.height);
      screenMeta = {
        ...screenMeta,
        // The recorded frame is now the region, not the display.
        frame: { width: cropped.pixels.w, height: cropped.pixels.h },
        crop: { frame, x: cropped.pixels.x, y: cropped.pixels.y },
      };
    }
  }
  const screenForRecorder = cropped?.stream ?? screenStream;

  const parts = [
    screenForRecorder && record(screenForRecorder, "screen", VIDEO_MIMES, screenMeta),
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
      // The cropper and the share it reads from are not among `parts` — the
      // recorder only ever saw the generated track. Without these the browser's
      // "you are sharing your screen" bar stays up after Stop, which reads as
      // Studio still recording.
      cropped?.stop();
      stopStream(screenStream);
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
