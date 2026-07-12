import { create } from "zustand";
import { subscribeJobs } from "./api";
import type { JobEvent } from "./types";

export interface JobState {
  id: string;
  kind: string;
  progress: number;
  status: "running" | "done" | "error";
  message: string;
  log: string[];
}

interface JobsStore {
  jobs: Record<string, JobState>;
  dismiss: (id: string) => void;
}

export const useJobs = create<JobsStore>((set) => ({
  jobs: {},
  dismiss: (id) =>
    set((s) => {
      const j = { ...s.jobs };
      delete j[id];
      return { jobs: j };
    }),
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
    if (ev.type === "error") next.status = "error";
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

// awaitJob resolves with the job's result payload when it completes.
export function awaitJob(jobId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    waiters.set(jobId, { resolve, reject });
    // auto-dismiss finished jobs from the overlay a few seconds later
  });
}
