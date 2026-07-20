// Live preview for the plugin editors.
//
// A real render of these clips takes seconds to minutes, so "live" cannot mean
// re-rendering on every keystroke. What it means here: after editing stops,
// render the generator's declared *cheap* variant (fewer frames, no voiceover,
// smaller resolution) and show it. A newer edit supersedes the render in flight
// rather than queueing behind it, so what you get back is always the newest
// state, never a backlog of intermediate ones.
//
// A generator with no preview mode gets no preview, and the caller says so
// instead of showing a spinner that will never resolve.

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";
import { awaitJob } from "./jobs";

// How long editing must be idle before spending a render on it. Long enough that
// typing a line of code doesn't fire one per character, short enough to feel
// like a response to what you just did.
const IDLE_MS = 900;

export interface LivePreview {
  url: string | null;
  rendering: boolean;
  error: string | null;
  /** Request a preview of `input`+`params`; debounced and superseding. */
  request: (input: string, params: Record<string, string>) => void;
  /** Drop the current preview (e.g. after committing a real re-render). */
  clear: () => void;
}

export function useLivePreview(
  projectId: string,
  generatorId: string,
  key: string,
  enabled: boolean
): LivePreview {
  const [url, setUrl] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Every request gets a sequence number; a response is only applied if it is
  // still the newest. The backend cancels the superseded render, but the losing
  // request can still resolve first, and showing it would be showing stale state.
  const seq = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const request = useCallback(
    (input: string, params: Record<string, string>) => {
      if (!enabled || !projectId || !input.trim()) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(async () => {
        const mine = ++seq.current;
        setRendering(true);
        setError(null);
        try {
          const { jobId } = await api.previewClip(projectId, generatorId, input, params, key);
          const data = await awaitJob(jobId);
          if (!alive.current || mine !== seq.current) return; // superseded
          const next = (data as { url?: string } | null)?.url;
          if (next) setUrl(next);
        } catch (e) {
          // A superseded preview is cancelled server-side, which surfaces here as
          // a failure. That's expected, not something to report.
          if (alive.current && mine === seq.current) setError((e as Error).message);
        } finally {
          if (alive.current && mine === seq.current) setRendering(false);
        }
      }, IDLE_MS);
    },
    [enabled, projectId, generatorId, key]
  );

  const clear = useCallback(() => {
    seq.current++; // orphan anything in flight
    if (timer.current) clearTimeout(timer.current);
    setUrl(null);
    setRendering(false);
    setError(null);
  }, []);

  return { url, rendering, error, request, clear };
}
