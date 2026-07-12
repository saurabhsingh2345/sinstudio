import { create } from "zustand";

export interface Toast {
  id: string;
  kind: "info" | "error" | "success";
  msg: string;
}

interface ToastStore {
  toasts: Toast[];
  push: (kind: Toast["kind"], msg: string) => void;
  dismiss: (id: string) => void;
}

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push: (kind, msg) => {
    const id = Math.random().toString(36).slice(2);
    set((s) => ({ toasts: [...s.toasts, { id, kind, msg }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4500);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export const toast = {
  info: (m: string) => useToasts.getState().push("info", m),
  error: (m: string) => useToasts.getState().push("error", m),
  success: (m: string) => useToasts.getState().push("success", m),
};
