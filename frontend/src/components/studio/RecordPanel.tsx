import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { api } from "../../api";
import { autoFrame } from "../../autoFrame";
import { canvasForSource } from "../../canvasFit";
import {
  canMapToVideo,
  probeCursord,
  startCursorTracking,
  stopCursorTracking,
  toSidecar,
  type CursorHealth,
} from "../../cursor";
import {
  clampRegion,
  isRegionRecordingSupported,
  normRegion,
  regionPixels,
  type Region,
} from "../../region";
import {
  isRecordingSupported,
  listInputs,
  startRecording,
  trackFrameSize,
  type RecordKind,
  type RecordOptions,
  type RecordingHandle,
} from "../../recorder";
import {
  isFloatingControlsSupported,
  openFloatingControls,
  type FloatingControls,
} from "../../recorderWindow";
import { useStudio } from "../../state";
import { toast } from "../../toast";
import type { Clip } from "../../types";
import { clipPlayDur } from "../../types";
import { Field, ToggleRow } from "./inspector-bits";
import { RecordingReadiness } from "./RecordingReadiness";
import { PostRecordChecklist, type PostRecordSummary } from "./PostRecordChecklist";
import { Teleprompter } from "./Teleprompter";
// Where each captured source belongs on the timeline. Screen is the spine;
// a webcam is picture-in-picture over it; narration is its own audio lane so
// its level stays independent of whatever the screen recording picked up.
const RECORD_LANE: Record<RecordKind, "video" | "overlay" | "audio"> = {
  screen: "video",
  camera: "overlay",
  mic: "audio",
};

export function RecordPanel({
  projectId,
  onClose,
  onExport,
  onEnterReview,
}: {
  projectId: string;
  onClose: () => void;
  onExport?: () => void;
  onEnterReview?: (summary: PostRecordSummary) => void;
}) {
  const addAsset = useStudio((s) => s.addAsset);
  const addSyncedClips = useStudio((s) => s.addSyncedClips);
  const [opts, setOpts] = useState<RecordOptions>({
    screen: true,
    camera: false,
    mic: true,
    systemAudio: false,
    fps: 30,
  });
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [handle, setHandle] = useState<RecordingHandle | null>(null);
  const [paused, setPaused] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [cursord, setCursord] = useState<CursorHealth | null>(null);
  const [trackCursor, setTrackCursor] = useState(true);
  const [showClicks, setShowClicks] = useState(true);
  const [ownCursor, setOwnCursor] = useState(true);
  const screenRef = useRef<HTMLVideoElement>(null);
  const cameraRef = useRef<HTMLVideoElement>(null);
  const supported = isRecordingSupported();

  // Region recording is a two-phase start: the share has to exist before a
  // rectangle can be drawn on it, so "framing" holds the granted stream while
  // the user picks, and the same stream is then handed to startRecording.
  const [wantRegion, setWantRegion] = useState(false);
  const [framing, setFraming] = useState<{ stream: MediaStream; frame: { width: number; height: number } } | null>(null);
  const [region, setRegion] = useState<Region>({ x: 0.2, y: 0.15, w: 0.6, h: 0.6 });
  const [tracking, setTracking] = useState(false);
  const regionOK = isRegionRecordingSupported();
  // The framing stream, mirrored into a ref so the share's own "ended" listener
  // can tell "the user stopped sharing while still framing" from "framing ended
  // because recording began". Without it, hitting the browser's Stop bar mid-
  // recording would unwind the framing session underneath the recorder.
  const framingRef = useRef<MediaStream | null>(null);
  const trackingRef = useRef(false);
  // The floating controls live in another window and outlive any one render, so
  // they act through refs rather than closing over state that will be stale by
  // the time someone presses Stop.
  const floatingRef = useRef<FloatingControls | null>(null);
  const handleRef = useRef<RecordingHandle | null>(null);
  const [postRecord, setPostRecord] = useState<PostRecordSummary | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [useCountdown, setUseCountdown] = useState(true);
  const countdownRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (countdownRef.current) clearTimeout(countdownRef.current);
  }, []);

  useEffect(() => {
    void listInputs().then(({ mics }) => setMics(mics));
  }, [handle]);

  // The cursor helper is optional and usually absent, so this is a quiet probe
  // whose only effect is whether we offer the checkbox.
  useEffect(() => {
    void probeCursord().then(setCursord);
  }, []);

  // Elapsed clock. Derived from the handle's start rather than counted up, so
  // it stays honest if the tab is backgrounded and timers are throttled.
  useEffect(() => {
    if (!handle || paused) return;
    const t = setInterval(() => {
      const secs = (Date.now() - handle.startedAt) / 1000;
      setElapsed(secs);
      floatingRef.current?.setElapsed(secs);
    }, 200);
    return () => clearInterval(t);
  }, [handle, paused]);

  // Attach the live streams to their preview elements so you can see what is
  // actually being captured before committing minutes to it.
  useEffect(() => {
    if (screenRef.current && handle?.preview.screen) screenRef.current.srcObject = handle.preview.screen;
    if (cameraRef.current && handle?.preview.camera) cameraRef.current.srcObject = handle.preview.camera;
  }, [handle]);

  const set = (patch: Partial<RecordOptions>) => setOpts((o) => ({ ...o, ...patch }));

  const finish = useCallback(
    async (h: RecordingHandle) => {
      setSaving(true);
      floatingRef.current?.close();
      floatingRef.current = null;
      handleRef.current = null;
      try {
        const tracks = await h.stop();
        // Always collect what the helper has, even if we end up not attaching
        // it — leaving it running would poison the next recording's session.
        const cursorRec = h.cursorTracking ? await stopCursorTracking() : null;
        setHandle(null);
        setPaused(false);
        if (!tracks.length) {
          toast.error("Nothing was captured.");
          return;
        }
        const placed: { assetId: string; lane: "video" | "overlay" | "audio"; startedAt: number }[] = [];
        for (const tr of tracks) {
          // Cursor data belongs only to the screen capture, and only when that
          // capture is a whole monitor — see canMapToVideo.
          const mappable = tr.kind === "screen" && tr.video && canMapToVideo(tr.surface);
          // tr.crop is set only for a region recording, and carries the whole
          // frame the region came out of — pointer samples are still in screen
          // coordinates, so both are needed to place them.
          const sidecar = cursorRec && mappable
            ? toSidecar(cursorRec, tr.startedAt, tr.video!, !!tr.cursorHidden, tr.crop)
            : undefined;
          const res = await api.ingestRecording(
            projectId,
            tr.blob,
            tr.filename,
            `recording-${tr.kind}`,
            sidecar
          );
          if (!res.asset) {
            toast.error(`${tr.kind}: ${res.importError || "upload failed"}`);
            continue;
          }
          if (res.remuxError) toast.error(`${tr.kind}: couldn't repair the container — scrubbing may be rough.`);
          if (res.cursorError) toast.error(`${tr.kind}: cursor data rejected — ${res.cursorError}`);
          addAsset(res.asset);
          placed.push({ assetId: res.asset.id, lane: RECORD_LANE[tr.kind], startedAt: tr.startedAt });
        }
        // Say why, rather than leaving the effects mysteriously unavailable.
        if (cursorRec && !tracks.some((tr) => tr.kind === "screen" && canMapToVideo(tr.surface))) {
          toast.info("Cursor data needs a whole-screen recording — a window or tab share can't be mapped.");
        }
        if (placed.length) {
          addSyncedClips(placed);
          toast.success(`${placed.length} recorded track${placed.length > 1 ? "s" : ""} → timeline`);
          let autoZoomClips = 0;
          const hadCursor = placed.some((p) =>
            useStudio.getState().doc?.assets.find((a) => a.id === p.assetId)?.hasCursor,
          );
          // The camera work happens here, not in a panel the user has to find.
          await autoFrameRecordings(placed, (n) => {
            autoZoomClips = n;
          });
          const docAfter = useStudio.getState().doc;
          let primaryScreen: PostRecordSummary["primaryScreen"];
          const screenItem = placed.find((p) => p.lane === "video");
          if (screenItem && docAfter) {
            for (const t of docAfter.tracks) {
              const c = t.clips?.find((cl) => cl.assetId === screenItem.assetId);
              if (c) {
                primaryScreen = { trackId: t.id, clipId: c.id, assetId: screenItem.assetId };
                break;
              }
            }
          }
          const summary = { trackCount: placed.length, autoZoomClips, hadCursor: !!hadCursor, primaryScreen };
          if (onEnterReview) onEnterReview(summary);
          else setPostRecord(summary);
        }
      } catch (e) {
        toast.error(String((e as Error)?.message || e));
      } finally {
        setSaving(false);
      }
    },
    [projectId, addAsset, addSyncedClips, onEnterReview]
  );

  /*
   * Acquire the share and stop, so a region can be drawn on it.
   *
   * Cursor tracking starts HERE rather than at the second step, because
   * cursor:"never" is a constraint on getDisplayMedia and cannot be applied
   * afterwards — deciding to hide the real cursor has to happen before the
   * share exists. Tracking early is harmless: samples before the video's first
   * frame are dropped when the sidecar is built.
   */
  const beginFraming = async () => {
    try {
      const wantCursor = !!cursord?.supported && trackCursor && opts.screen;
      const t = wantCursor ? await startCursorTracking() : false;
      if (wantCursor && !t) toast.info("Cursor helper didn't start — recording without it.");
      setTracking(t);
      trackingRef.current = t;

      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: opts.fps },
          ...(t && ownCursor ? { cursor: "never" } : {}),
        } as MediaTrackConstraints,
        audio: opts.systemAudio,
      });
      const frame = trackFrameSize(stream.getVideoTracks()[0]);
      if (!frame) {
        stream.getTracks().forEach((x) => x.stop());
        toast.error("Couldn't read the shared display's size.");
        return;
      }
      // Ending the share from the browser's own bar while framing has to unwind
      // this, or the panel sits on a dead stream showing a frozen picture. Only
      // while this stream is still the framing one — once recording starts, the
      // recorder owns it and has its own listener.
      stream.getVideoTracks().forEach((x) =>
        x.addEventListener("ended", () => {
          if (framingRef.current === stream) cancelFraming();
        })
      );
      framingRef.current = stream;
      setFraming({ stream, frame });
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      if (/permission|denied|abort/i.test(msg)) toast.info("Recording cancelled.");
      else toast.error(msg);
      if (trackingRef.current) void stopCursorTracking();
      setTracking(false);
      trackingRef.current = false;
    }
  };

  const cancelFraming = () => {
    framingRef.current = null;
    setFraming((f) => {
      f?.stream.getTracks().forEach((t) => t.stop());
      return null;
    });
    // Collect and discard, or the helper keeps running into the next session.
    if (trackingRef.current) void stopCursorTracking();
    setTracking(false);
    trackingRef.current = false;
  };

  /*
   * Frame a fresh recording the moment it lands.
   *
   * The decision itself lives in autoFrame.ts so it can be tested without a
   * real screen share; this is only the wiring. It writes through the normal
   * mutation path, so the whole pass is one undo away, every diamond stays
   * draggable, and the Auto Zoom panel still retunes or clears it.
   */
  const autoFrameRecordings = useCallback(
    async (
      placed: { assetId: string; lane: "video" | "overlay" | "audio"; startedAt: number }[],
      onZoom?: (count: number) => void,
    ) => {
      const doc = useStudio.getState().doc;
      const canvas = doc?.canvas;
      if (!doc || !canvas) return;

      // Shape the frame to the recording before anything else looks at it.
      // A 3:2 screen in a 16:9 canvas is letterboxed with black down both
      // sides, and that reads as the zoom escaping the footage when it is
      // nothing of the kind. Only for the first visual clip: after that the
      // canvas is a decision someone made.
      const arriving = new Set(placed.map((i) => i.assetId));
      // Anything visual that was here BEFORE this recording. Counting the
      // clips just placed would see a second recording as a first one and
      // reshape a canvas that already has a timeline built against it.
      const preExisting = doc.tracks
        .filter((t) => t.kind === "video" || t.kind === "overlay" || t.kind === "background")
        .flatMap((t) => t.clips ?? [])
        .filter((c) => !arriving.has(c.assetId));
      const firstVideo = placed.find((i) => {
        const a = doc.assets.find((x) => x.id === i.assetId);
        return a && a.kind === "video" && a.width > 0;
      });
      if (firstVideo && preExisting.length === 0) {
        const a = doc.assets.find((x) => x.id === firstVideo.assetId)!;
        const fitted = canvasForSource({ width: a.width, height: a.height }, canvas);
        if (fitted) {
          useStudio.getState().mutate((d) => {
            d.canvas = { ...d.canvas, ...fitted };
          });
          toast.info(`Canvas set to ${fitted.width}x${fitted.height} to match your screen`);
        }
      }

      let zoomTotal = 0;
      for (const item of placed) {
        const asset = doc.assets.find((a) => a.id === item.assetId);
        if (!asset?.hasCursor) continue;

        // addSyncedClips has just created this; the asset is unique to one ingest.
        let found: { trackId: string; clip: Clip } | null = null;
        for (const t of doc.tracks) {
          const c = t.clips?.find((c) => c.assetId === item.assetId);
          if (c) {
            found = { trackId: t.id, clip: c };
            break;
          }
        }
        if (!found) continue;

        try {
          const { track } = await api.cursorTrack(doc.id, item.assetId);
          const framed = autoFrame(
            asset,
            found.clip,
            track as never,
            clipPlayDur(found.clip),
            // Re-read: the canvas may have just been reshaped to the recording,
            // and framing computed against the old one would aim every zoom at
            // a frame that no longer exists.
            (() => {
              const c = useStudio.getState().doc?.canvas ?? canvas;
              return { width: c.width, height: c.height };
            })(),
            undefined,
            showClicks
          );
          if (!framed) continue;
          useStudio.getState().updateClip(found.trackId, found.clip.id, framed.patch);
          if (framed.zooms) {
            zoomTotal += framed.zooms;
            toast.success(
              `${framed.zooms} zoom${framed.zooms > 1 ? "s" : ""} from your clicks — tune in Auto Zoom`
            );
          }
        } catch {
          // Framing is a convenience on top of a recording that already landed
          // safely. It must never be why an ingest reports failure.
        }
      }
      onZoom?.(zoomTotal);
    },
    [showClicks]
  );

  const runCountdown = (): Promise<void> =>
    new Promise((resolve) => {
      if (!useCountdown) {
        resolve();
        return;
      }
      let n = 3;
      setCountdown(n);
      const tick = () => {
        n -= 1;
        if (n <= 0) {
          setCountdown(null);
          resolve();
        } else {
          setCountdown(n);
          countdownRef.current = setTimeout(tick, 1000);
        }
      };
      countdownRef.current = setTimeout(tick, 1000);
    });

  const start = async () => {
    // FIRST, and before anything is awaited: requestWindow needs transient user
    // activation, and the screen-share picker takes longer than that lasts. A
    // window requested after the share is granted is simply refused.
    const floating = await openFloatingControls({
      onPause: () => {
        const h = handleRef.current;
        if (!h) return;
        h.pause();
        setPaused(true);
        floatingRef.current?.setPaused(true);
      },
      onResume: () => {
        const h = handleRef.current;
        if (!h) return;
        h.resume();
        setPaused(false);
        floatingRef.current?.setPaused(false);
      },
      onStop: () => {
        const h = handleRef.current;
        if (h) void finish(h);
      },
    });
    floatingRef.current = floating;

    try {
      await runCountdown();
      // Framing already started tracking and acquired the share; a plain start
      // does both here.
      let t = tracking;
      if (!framing) {
        // Start tracking before capture, so the pointer's position is already
        // known at frame zero rather than only from its first movement after.
        const wantCursor = !!cursord?.supported && trackCursor && opts.screen;
        t = wantCursor ? await startCursorTracking() : false;
        if (wantCursor && !t) toast.info("Cursor helper didn't start — recording without it.");
      }
      // Only hide the real cursor once tracking is confirmed running, or the
      // recording would have no cursor at all rather than an editable one.
      opts.hideCursor = t && ownCursor;

      const h = await startRecording({
        ...opts,
        screenStream: framing?.stream,
        region: framing && wantRegion ? region : undefined,
      });
      // The recorder owns the share from here; framing must let go of it
      // WITHOUT stopping it.
      framingRef.current = null;
      setFraming(null);
      setTracking(false);
      trackingRef.current = false;
      h.cursorTracking = t;
      handleRef.current = h;
      setElapsed(0);
      setHandle(h);
      // The browser's own "Stop sharing" bar ends the stream without going
      // through our button, so the recording has to finish itself.
      h.preview.screen?.getVideoTracks().forEach((t) =>
        t.addEventListener("ended", () => void finish(h))
      );
    } catch (e) {
      const msg = String((e as Error)?.message || e);
      // Cancelling the picker is a normal thing to do, not an error worth shouting about.
      if (/permission|denied|abort/i.test(msg)) toast.info("Recording cancelled.");
      else toast.error(msg);
      // No take: the controls have nothing to control.
      floatingRef.current?.close();
      floatingRef.current = null;
    }
  };

  if (!supported) {
    return (
      <div className="px-3 py-6 text-center text-[11px] leading-relaxed text-muted-foreground">
        This browser can't capture the screen. Chrome, Edge or Firefox on desktop can.
        <div className="mt-2">
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Back to media</Button>
        </div>
      </div>
    );
  }

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(Math.floor(elapsed % 60)).padStart(2, "0");

  return (
    <div className="scrollbar-thin relative flex-1 space-y-2 overflow-y-auto px-3 pb-3 pt-2">
      {countdown != null && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/50">
          <span className="text-6xl font-bold tabular text-white">{countdown}</span>
        </div>
      )}
      {handle ? (
        <>
          <div className="flex items-center gap-2 rounded-md border border-red-500/40 bg-red-500/10 p-2">
            <span className={cn("h-2 w-2 rounded-full bg-red-500", !paused && "animate-pulse")} />
            <span className="text-[12px] font-medium tabular">{mm}:{ss}</span>
            <span className="text-[10px] text-muted-foreground">{paused ? "paused" : "recording"}</span>
          </div>
          {handle.preview.screen && (
            <video ref={screenRef} autoPlay muted playsInline className="w-full rounded border hairline bg-black" />
          )}
          {handle.preview.camera && (
            <video ref={cameraRef} autoPlay muted playsInline className="w-full rounded border hairline bg-black" />
          )}
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 flex-1 bg-panel-3 text-xs"
              onClick={() => {
                paused ? handle.resume() : handle.pause();
                setPaused(!paused);
                floatingRef.current?.setPaused(!paused);
              }}
            >
              {paused ? "Resume" : "Pause"}
            </Button>
            <Button
              size="sm"
              disabled={saving}
              className="h-7 flex-1 bg-red-600 text-xs text-white hover:bg-red-600/90"
              onClick={() => void finish(handle)}
            >
              {saving ? "Saving…" : "Stop"}
            </Button>
          </div>
        </>
      ) : framing ? (
        <>
          <RegionPicker
            stream={framing.stream}
            frame={framing.frame}
            region={region}
            onChange={setRegion}
          />
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" className="h-7 flex-1 bg-panel-3 text-xs" onClick={cancelFraming}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="h-7 flex-1 bg-red-600 text-xs text-white hover:bg-red-600/90"
              onClick={() => void start()}
            >
              ● Start recording
            </Button>
          </div>
        </>
      ) : (
        <>
          {postRecord && !onEnterReview && (
            <PostRecordChecklist
              summary={postRecord}
              onDismiss={() => {
                setPostRecord(null);
                onClose();
              }}
              onOpenExport={
                onExport
                  ? () => {
                      setPostRecord(null);
                      onClose();
                      onExport();
                    }
                  : undefined
              }
            />
          )}
          <RecordingReadiness
            opts={opts}
            cursord={cursord}
            wantRegion={wantRegion}
            regionOK={regionOK}
            trackCursor={trackCursor}
          />
          <Teleprompter active={!!handle} elapsed={elapsed} />
          <div className="space-y-1">
            <ToggleRow label="Screen" hint="You'll pick the display or window next." checked={opts.screen} onChange={(v) => set({ screen: v })} />
            {opts.screen && (
              <ToggleRow
                label="Just a region"
                hint={
                  !regionOK
                    ? "This browser can't crop a capture. Chrome or Edge can."
                    : "Record a rectangle instead of the whole screen — a smaller file, cropped before it's ever encoded."
                }
                checked={wantRegion && regionOK}
                disabled={!regionOK}
                onChange={setWantRegion}
              />
            )}
            <ToggleRow label="Camera" hint="Lands on the overlay track as picture-in-picture." checked={opts.camera} onChange={(v) => set({ camera: v })} />
            <ToggleRow label="Microphone" hint="Its own audio track, so narration stays adjustable." checked={opts.mic} onChange={(v) => set({ mic: v })} />
            <ToggleRow
              label="System audio"
              hint={opts.screen ? "Chrome only, and only for a tab or window share." : "Needs a screen share."}
              checked={opts.systemAudio && opts.screen}
              disabled={!opts.screen}
              onChange={(v) => set({ systemAudio: v })}
            />
            {cursord?.supported && (
              <ToggleRow
                label="Studio draws the cursor"
                hint={
                  !trackCursor || !opts.screen
                    ? "Needs cursor tracking."
                    : "Keeps the real cursor out of the recording so it can be smoothed, resized and restyled afterwards."
                }
                checked={ownCursor && trackCursor && opts.screen}
                disabled={!trackCursor || !opts.screen}
                onChange={setOwnCursor}
              />
            )}
            {cursord?.supported ? (
              <ToggleRow
                label="Cursor tracking"
                hint={
                  !opts.screen
                    ? "Needs a screen share."
                    : cursord.clicks
                      ? "Records pointer motion and clicks for cursor effects. Share a whole screen."
                      : "Records pointer motion. Clicks aren't visible on this platform."
                }
                checked={trackCursor && opts.screen}
                disabled={!opts.screen}
                onChange={setTrackCursor}
              />
            ) : (
              <div className="px-1 py-1 text-[10px] leading-snug text-muted-foreground">
                Cursor effects need the local <code className="font-mono">cursord</code> helper.
                Run it from <code className="font-mono">tools/cursord</code> and reopen this panel.
              </div>
            )}
            {cursord?.supported && (
              <ToggleRow
                label="Click rings"
                hint={
                  !trackCursor || !opts.screen
                    ? "Needs cursor tracking."
                    : !cursord.clicks
                      ? "Click detection isn't available on this platform."
                      : "White expanding rings on each mouse press in the preview and export."
                }
                checked={showClicks && trackCursor && opts.screen}
                disabled={!trackCursor || !opts.screen || !cursord.clicks}
                onChange={setShowClicks}
              />
            )}
          </div>
          {opts.mic && mics.length > 1 && (
            <select
              value={opts.micDeviceId ?? ""}
              onChange={(e) => set({ micDeviceId: e.target.value || undefined })}
              className="h-7 w-full rounded border hairline bg-panel px-1 text-[11px] outline-none"
            >
              <option value="">Default microphone</option>
              {mics.map((m, i) => (
                <option key={m.deviceId} value={m.deviceId}>{m.label || `Microphone ${i + 1}`}</option>
              ))}
            </select>
          )}
          <ToggleRow
            label="3-second countdown"
            hint="Gives you a moment before capture begins."
            checked={useCountdown}
            onChange={setUseCountdown}
          />
          <Field label="Frame rate">
            <select
              value={opts.fps}
              onChange={(e) => set({ fps: Number(e.target.value) })}
              className="h-7 w-full rounded border hairline bg-panel px-1 text-[11px] outline-none"
            >
              <option value={24}>24 fps</option>
              <option value={30}>30 fps</option>
              <option value={60}>60 fps — smoother, larger files</option>
            </select>
          </Field>
          <Button
            size="sm"
            className="h-8 w-full bg-red-600 text-xs text-white hover:bg-red-600/90 disabled:opacity-40"
            disabled={!opts.screen && !opts.camera && !opts.mic}
            onClick={() => void (wantRegion && regionOK && opts.screen ? beginFraming() : start())}
          >
            {wantRegion && regionOK && opts.screen ? "Choose the region…" : "● Start recording"}
          </Button>
          <div className="text-[10px] leading-relaxed text-muted-foreground">
            Each source becomes its own clip, aligned to the moment they started — so
            narration and screen stay in sync but can be edited apart.
            {isFloatingControlsSupported() && (
              <>
                {" "}
                Controls float above your other windows while you record, so you can stop without
                coming back here.
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}


/**
 * Drag the rectangle to record out of a live view of the share.
 *
 * Drawn on the live stream rather than a still, because what you are framing is
 * usually moving — a menu you are about to open, a terminal that is scrolling —
 * and a frozen frame makes you guess whether the thing you want is inside.
 *
 * The region is stored as fractions of the frame, so this preview's own size is
 * irrelevant to the result and the panel can be any width.
 */
function RegionPicker({
  stream,
  frame,
  region,
  onChange,
}: {
  stream: MediaStream;
  frame: { width: number; height: number };
  region: Region;
  onChange: (r: Region) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  const px = regionPixels(region, frame.width, frame.height);

  // A drag on empty space draws a new region; a drag on the region moves it.
  const draw = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    setDrawing(true);
    const ox = (e.clientX - rect.left) / rect.width;
    const oy = (e.clientY - rect.top) / rect.height;
    const move = (ev: PointerEvent) => {
      const cx = (ev.clientX - rect.left) / rect.width;
      const cy = (ev.clientY - rect.top) / rect.height;
      onChange(clampRegion(normRegion(ox, oy, cx - ox, cy - oy)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setDrawing(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const drag = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();
    e.stopPropagation();
    const start = { ...region };
    const x0 = e.clientX;
    const y0 = e.clientY;
    const move = (ev: PointerEvent) => {
      onChange(
        clampRegion({
          ...start,
          x: start.x + (ev.clientX - x0) / rect.width,
          y: start.y + (ev.clientY - y0) / rect.height,
        })
      );
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const pct = (v: number) => `${v * 100}%`;

  return (
    <div className="space-y-1.5">
      <div
        ref={boxRef}
        onPointerDown={draw}
        className={cn(
          "relative w-full select-none overflow-hidden rounded border hairline bg-black",
          drawing ? "cursor-crosshair" : "cursor-crosshair"
        )}
        style={{ aspectRatio: `${frame.width} / ${frame.height}` }}
      >
        <video ref={videoRef} autoPlay muted playsInline className="pointer-events-none h-full w-full object-contain" />
        {/* Everything outside the region dimmed, so the framing reads at a glance. */}
        <div className="pointer-events-none absolute inset-0 bg-black/55" />
        <div
          onPointerDown={drag}
          className="absolute cursor-move border-2 border-brand"
          style={{ left: pct(region.x), top: pct(region.y), width: pct(region.w), height: pct(region.h) }}
        >
          {/* The unmasked window: the live picture shown again, unclipped by the
              dim above it, so the region shows what will actually be recorded. */}
          <div className="absolute inset-0 overflow-hidden">
            <video
              autoPlay
              muted
              playsInline
              ref={(el) => {
                if (el && el.srcObject !== stream) el.srcObject = stream;
              }}
              className="pointer-events-none absolute object-contain"
              style={{
                width: pct(1 / Math.max(region.w, 0.001)),
                height: pct(1 / Math.max(region.h, 0.001)),
                left: pct(-region.x / Math.max(region.w, 0.001)),
                top: pct(-region.y / Math.max(region.h, 0.001)),
              }}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>Drag to draw the region, or drag it to move.</span>
        {/* The real encoded size, not the fractions — even numbers included, so
            what is promised here is what the file turns out to be. */}
        <span className="tabular">
          {px.w}×{px.h}
        </span>
      </div>
    </div>
  );
}
