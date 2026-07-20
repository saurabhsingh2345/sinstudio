import { useCallback, useEffect, useState } from "react";

// Arc dashboard/wizard theme. Independent of the dark editor (StudioView):
// these screens paint their own full-viewport background, so toggling here never
// touches the editor's palette. Default is light (matches the reference design);
// the choice is remembered in localStorage.
export type ArcTheme = "light" | "dark";

const KEY = "arc-theme";

function read(): ArcTheme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark") return v;
  } catch {
    /* ignore */
  }
  return "light";
}

export function useArcTheme(): [ArcTheme, () => void] {
  const [theme, setTheme] = useState<ArcTheme>(read);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === "light" ? "dark" : "light")), []);
  return [theme, toggle];
}
