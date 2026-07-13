import { create } from "zustand";
import { subscribeJobs, api } from "./api";
import type { JobEvent } from "./types";

export interface JobState {
  id: string;
  kind: string;
  progress: number;
  status: "running" | "done" | "error" | "canceled";
  message: string;
  log: string[];
}

interface JobsStore {
  jobs: Record<string, JobState>;
  dismiss: (id: string) => void;
  cancel: (id: string) => void;
}

export const useJobs = create<JobsStore>((set) => ({
  jobs: {},
  dismiss: (id) =>
    set((s) => {
      const j = { ...s.jobs };
      delete j[id];
      return { jobs: j };
    }),
  cancel: (id) => {
    api.cancelJob(id).catch(() => {});
  },
}));

const waiters = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void }>();

function apply(ev: JobEvent) {
  useJobs.setState((s) => {
    const prev: JobState =
      s.jobs[ev.jobId] || { id: ev.jobId, kind: ev.kind, progress: 0, status: "running", message: "", log: [] };
    const next: JobState = { ...prev, kind: ev.kind, progress: ev.progress };
    if (ev.type === "log" && ev.message) next.log = [...prev.log, ev.message].slice(-200);
    if (ev.message) next.message = ev.message;
    if (ev.type === "done") next.status = "done";
    if (ev.type === "error") next.status = ev.message === "canceled" ? "canceled" : "error";
    return { jobs: { ...s.jobs, [ev.jobId]: next } };
  });

  const w = waiters.get(ev.jobId);
  if (w) {
    if (ev.type === "done") {
      w.resolve(ev.data);
      waiters.delete(ev.jobId);
    } else if (ev.type === "error") {
      w.reject(new Error(ev.message || "job failed"));
      waiters.delete(ev.jobId);
    }
  }
}

let started = false;
export function startJobStream() {
  if (started) return;
  started = true;
  subscribeJobs(apply);
}

// awaitJob resolves with the job's result payload when it completes. It primarily
// listens on the SSE stream, but also polls GET /api/jobs/{id} as a fallback so a
// dropped terminal event (slow client) can't hang the caller forever. Note the
// poll can't recover the `done` payload (e.g. the new asset) — the SSE `done`
// event carries that — so on a polled completion it resolves with null and relies
// on the overlay/state to reflect status; callers that need the payload should
// also react to the job store.
export function awaitJob(jobId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      waiters.delete(jobId);
      fn();
    };
    waiters.set(jobId, {
      resolve: (d) => done(() => resolve(d)),
      reject: (e) => done(() => reject(e)),
    });
    // Fallback: if SSE misses the terminal event, the server still knows the
    // final status. Poll every 3s.
    const poll = setInterval(async () => {
      try {
        const j = await api.getJob(jobId);
        if (j.status === "done") done(() => resolve(null));
        else if (j.status === "error" || j.status === "canceled")
          done(() => reject(new Error(j.message || j.status)));
      } catch {
        /* transient; keep polling */
      }
    }, 3000);
  });
}
