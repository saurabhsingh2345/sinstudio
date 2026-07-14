// Icon — a small, crisp line-icon set used across the editor chrome. Replaces
// emoji/unicode glyphs for a consistent, premium look. Stroke-based, inherits
// currentColor, 24px viewBox scaled by CSS (button svg { width:15px }).

export type IconName =
  | "back" | "undo" | "redo" | "export" | "renders"
  | "play" | "pause" | "start" | "end"
  | "split" | "title" | "marker" | "caption" | "scope"
  | "plus" | "minus" | "fit" | "trash" | "close"
  | "up" | "down" | "apps" | "library" | "import" | "generate"
  | "video" | "overlay" | "audio" | "eye" | "eyeOff";

const P: Record<IconName, JSX.Element> = {
  back: <path d="M15 18l-6-6 6-6" />,
  undo: <path d="M9 14L4 9l5-5M4 9h11a5 5 0 0 1 0 10h-1" />,
  redo: <path d="M15 14l5-5-5-5M20 9H9a5 5 0 0 0 0 10h1" />,
  export: <><path d="M12 15V3" /><path d="M8 7l4-4 4 4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  renders: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M10 9l5 3-5 3V9z" /></>,
  play: <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" /></>,
  start: <><path d="M18 5v14l-11-7 11-7z" fill="currentColor" stroke="none" /><rect x="4" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  end: <><path d="M6 5v14l11-7L6 5z" fill="currentColor" stroke="none" /><rect x="17.6" y="5" width="2.4" height="14" rx="1" fill="currentColor" stroke="none" /></>,
  split: <><path d="M12 3v6M12 15v6" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="18" r="2.5" /><path d="M8 16l8-11M16 16L8 5" /></>,
  title: <><path d="M5 6h14M12 6v13M9 19h6" /></>,
  marker: <path d="M12 3l3.5 6L12 21 8.5 9 12 3z" />,
  caption: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M7 11h5M7 14h8" /></>,
  scope: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M6 15l3-5 3 3 3-6 3 4" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  fit: <><path d="M4 9V5a1 1 0 0 1 1-1h4" /><path d="M20 9V5a1 1 0 0 0-1-1h-4" /><path d="M4 15v4a1 1 0 0 0 1 1h4" /><path d="M20 15v4a1 1 0 0 1-1 1h-4" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  up: <path d="M6 15l6-6 6 6" />,
  down: <path d="M6 9l6 6 6-6" />,
  apps: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  library: <><path d="M4 4h4v16H4zM10 4h4v16h-4z" /><path d="M17 5l3 .8-3 14.4-3-.8L17 5z" /></>,
  import: <><path d="M12 3v12" /><path d="M8 11l4 4 4-4" /><path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" /></>,
  generate: <><path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3z" /><path d="M19 14l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z" /></>,
  video: <><rect x="3" y="6" width="12" height="12" rx="2" /><path d="M15 10l6-3v10l-6-3" /></>,
  overlay: <><rect x="7" y="7" width="12" height="12" rx="2" /><path d="M5 15V6a1 1 0 0 1 1-1h9" /></>,
  audio: <path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4" />,
  eye: <><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.8M6.2 6.2A17 17 0 0 0 2 12s3.5 7 10 7a9.8 9.8 0 0 0 4-.8" /><path d="M3 3l18 18" /></>,
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name]}
    </svg>
  );
}
