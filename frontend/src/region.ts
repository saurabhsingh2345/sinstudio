// Region recording: capture a rectangle of the screen instead of all of it.
//
// The browser will not capture a region — getDisplayMedia hands back a whole
// monitor, window or tab and offers no way to ask for part of one. So the crop
// happens in the tab, between the display track and the MediaRecorder.
//
// It is done at CAPTURE time rather than at export time, which is the opposite
// of how zoom-n-pan and redaction work, and the reason is worth stating: a crop
// applied at export is arithmetically identical to a static zoom, and
// ZoomPanSection already does that. What it cannot do is make the recording
// smaller. Cropping 1280x720 out of a 5K display before it is ever encoded is
// the entire point — the file, the upload and the decode all shrink with it.
//
// The frames are cropped with WebCodecs rather than by drawing to a canvas.
// A canvas cropper has to be driven by requestAnimationFrame, and rAF stops in
// a backgrounded tab — which is every tab during a screen recording, because
// the user is by definition looking at the app being recorded. That version
// records a few seconds and then a freeze-frame. MediaStreamTrackProcessor is
// driven by frames arriving from the capture itself, so it keeps working with
// the tab hidden, and VideoFrame's visibleRect crops without copying pixels.

/** A rectangle of the captured frame, in fractions (0..1) of it. */
export interface Region {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A region resolved to whole pixels of a specific captured frame. */
export interface RegionPixels {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The smallest region worth recording, as a fraction of the frame. */
const MIN_FRACTION = 0.02;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Normalize a rectangle dragged in any direction to positive width/height. */
export function normRegion(x: number, y: number, w: number, h: number): Region {
  return {
    x: w < 0 ? x + w : x,
    y: h < 0 ? y + h : y,
    w: Math.abs(w),
    h: Math.abs(h),
  };
}

/**
 * Keep a region inside the frame it is cropped from.
 *
 * A region reaching outside the frame is not a rendering annoyance the way an
 * off-canvas callout is — VideoFrame rejects a visibleRect that does not fit,
 * so the whole recording fails to start. Clamping the origin and then the size
 * (rather than the other way round) keeps a region dragged off the edge at the
 * edge, instead of silently teleporting it inward.
 */
export function clampRegion(r: Region): Region {
  const w = Math.max(MIN_FRACTION, Math.min(1, r.w));
  const h = Math.max(MIN_FRACTION, Math.min(1, r.h));
  return {
    x: clamp01(Math.min(r.x, 1 - w)),
    y: clamp01(Math.min(r.y, 1 - h)),
    w,
    h,
  };
}

/**
 * Resolve a region against a real captured frame.
 *
 * Every dimension is forced EVEN. H.264 stores chroma at half resolution, so an
 * odd width or an odd offset has no representation in 4:2:0 — encoders either
 * refuse the frame or quietly round it, and a silently-shifted crop is worse
 * than a rejected one. Rounding the size DOWN and then pulling the origin back
 * if it would overhang keeps the result inside the frame in every case.
 */
export function regionPixels(r: Region, frameW: number, frameH: number): RegionPixels {
  const even = (v: number) => Math.max(2, Math.floor(v / 2) * 2);
  const c = clampRegion(r);

  const w = Math.min(even(c.w * frameW), even(frameW));
  const h = Math.min(even(c.h * frameH), even(frameH));
  // Origin last, so it can absorb the rounding rather than pushing the region
  // past the frame's edge.
  const x = Math.max(0, Math.min(even(c.x * frameW), even(frameW - w)));
  const y = Math.max(0, Math.min(even(c.y * frameH), even(frameH - h)));
  return { x, y, w, h };
}

/** Is this region effectively the whole frame? Then there is nothing to crop. */
export function isWholeFrame(r: Region | undefined): boolean {
  if (!r) return true;
  return r.x <= 0.001 && r.y <= 0.001 && r.w >= 0.999 && r.h >= 0.999;
}

/*
Insertable Streams, which TypeScript's DOM lib does not yet declare. Typed here
rather than cast away at each use, so a mistake in the pipeline is still a type
error.
*/
declare global {
  class MediaStreamTrackProcessor {
    constructor(init: { track: MediaStreamTrack });
    readonly readable: ReadableStream<VideoFrame>;
  }
  class MediaStreamTrackGenerator {
    constructor(init: { kind: "video" | "audio" });
    readonly writable: WritableStream<VideoFrame>;
  }
}

/**
 * Whether region recording can work here.
 *
 * Deliberately strict. The canvas fallback is not offered, because it would
 * freeze the moment the user looks at the window they are recording — a feature
 * that fails exactly when it is used is worse than one that is absent and says
 * so.
 */
export function isRegionRecordingSupported(): boolean {
  return (
    typeof MediaStreamTrackProcessor !== "undefined" && typeof MediaStreamTrackGenerator !== "undefined"
  );
}

export interface CroppedStream {
  stream: MediaStream;
  /** The exact pixel rect being cropped, for placing cursor coordinates. */
  pixels: RegionPixels;
  stop(): void;
}

/**
 * A stream carrying only `region` of `source`.
 *
 * Audio tracks are carried across untouched — cropping the picture must not
 * silently drop the system audio that came with the share.
 */
export function cropStream(source: MediaStream, region: Region, frameW: number, frameH: number): CroppedStream {
  const track = source.getVideoTracks()[0];
  if (!track) throw new Error("Nothing to crop — the share has no video.");
  const pixels = regionPixels(region, frameW, frameH);

  const processor = new MediaStreamTrackProcessor({ track });
  const generator = new MediaStreamTrackGenerator({ kind: "video" });
  const abort = new AbortController();

  const crop = new TransformStream<VideoFrame, VideoFrame>({
    transform(frame, ctrl) {
      try {
        // visibleRect crops by reinterpreting the frame, not by copying it, so
        // this costs nothing per frame beyond the object.
        const out = new VideoFrame(frame, {
          visibleRect: { x: pixels.x, y: pixels.y, width: pixels.w, height: pixels.h },
        });
        ctrl.enqueue(out);
      } catch {
        // A frame the crop doesn't fit (a display that changed resolution
        // mid-recording) is dropped rather than killing the recording.
      } finally {
        // Every frame must be closed or the capture pipeline stalls on a full
        // pool within a second or two.
        frame.close();
      }
    },
  });

  void processor.readable
    .pipeThrough(crop, { signal: abort.signal })
    .pipeTo(generator.writable, { signal: abort.signal })
    .catch(() => {
      /* aborted on stop, or the source ended — both are normal */
    });

  const stream = new MediaStream([generator as unknown as MediaStreamTrack]);
  for (const a of source.getAudioTracks()) stream.addTrack(a);

  return {
    stream,
    pixels,
    stop() {
      abort.abort();
      try {
        (generator as unknown as MediaStreamTrack).stop();
      } catch {
        /* already ended */
      }
    },
  };
}
