import type { ArcTheme } from "./theme";

// The Arc brand mark: a rounded dark tile with a gradient play triangle,
// matching the reference. `size` controls the tile; the glyph scales with it.
export function ArcLogo({ size = 40 }: { size?: number }) {
  const g = Math.round(size * 0.5);
  return (
    <span className="arc-logo" style={{ width: size, height: size }} aria-hidden>
      <svg width={g} height={g} viewBox="0 0 24 24" fill="none">
        <defs>
          <linearGradient id="arcPlay" x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8b7bff" />
            <stop offset="1" stopColor="#38d0ea" />
          </linearGradient>
        </defs>
        <path d="M7 5.5a1 1 0 0 1 1.53-.85l9 6.5a1 1 0 0 1 0 1.7l-9 6.5A1 1 0 0 1 7 18.5v-13Z" fill="url(#arcPlay)" />
      </svg>
    </span>
  );
}

// Light/dark toggle. Shows the icon of the mode you'd switch to.
export function ThemeToggle({
  theme,
  onToggle,
  className,
}: {
  theme: ArcTheme;
  onToggle: () => void;
  className?: string;
}) {
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      className={`arc-theme-toggle${className ? ` ${className}` : ""}`}
      onClick={onToggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
    >
      {theme === "light" ? (
        // moon
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
        </svg>
      ) : (
        // sun
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      )}
    </button>
  );
}
