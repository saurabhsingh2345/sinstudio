import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { ArcLogo, ThemeToggle } from "./arc/bits";
import { useArcTheme } from "./arc/theme";
import { NewProjectWizard } from "./arc/NewProjectWizard";

type Project = { id: string; name: string; updated: string };

export function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [theme, toggleTheme] = useArcTheme();
  const recentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.listProjects().then(setProjects).catch(console.error);
  }, []);

  const cls = `arc${theme === "dark" ? " arc-dark" : ""}`;

  if (creating) {
    return (
      <div className={cls}>
        <NewProjectWizard
          theme={theme}
          onToggleTheme={toggleTheme}
          onCancel={() => setCreating(false)}
          onCreated={onOpen}
        />
      </div>
    );
  }

  const browse = () =>
    recentRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div className={cls}>
      <div className="arc-landing">
        <header className="arc-landing__bar">
          <div className="arc-landing__brand">
            <ArcLogo size={40} />
            <div>
              <h2>Arc Studio</h2>
              <p>Video production for macOS</p>
            </div>
          </div>
          <div className="arc-spacer" />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
        </header>

        <main className="arc-landing__body">
          <div className="arc-landing__head">
            <span className="arc-pill">Apple Silicon video studio</span>
            <h1 className="arc-h1">What would you like to create?</h1>
            <p className="arc-sub">
              Start with a guided setup, then add assets and build your timeline one clear step at a time.
            </p>
          </div>

          <div className="arc-choices">
            <button className="arc-choice arc-choice--featured" onClick={() => setCreating(true)}>
              <span className="arc-choice__icon">
                <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className="arc-choice__body">
                <span className="arc-choice__title">Create a new project</span>
                <span className="arc-choice__desc">Choose canvas, background, tracks, and timing</span>
              </span>
            </button>

            <button className="arc-choice" onClick={browse}>
              <span className="arc-choice__icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 17L17 7M8 7h9v9" />
                </svg>
              </span>
              <span className="arc-choice__body">
                <span className="arc-choice__title">Open an existing project</span>
                <span className="arc-choice__desc">Jump back into a saved Arc Studio project</span>
                <span className="arc-choice__cta">Browse projects…</span>
              </span>
            </button>
          </div>

          <section className="arc-recent" ref={recentRef}>
            <p className="arc-eyebrow arc-eyebrow--muted arc-recent__label">Recent</p>
            <h3 className="arc-recent__title">Your projects</h3>

            {projects.length === 0 ? (
              <div className="arc-empty">Your recently opened projects will appear here.</div>
            ) : (
              <div className="arc-projects">
                {projects.map((p) => (
                  <button key={p.id} className="arc-pcard" onClick={() => onOpen(p.id)}>
                    <span className="arc-pcard__thumb">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="5" width="18" height="14" rx="2" />
                        <path d="M10 9l5 3-5 3V9Z" fill="currentColor" stroke="none" />
                      </svg>
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="arc-pcard__name">{p.name}</span>
                      <span className="arc-pcard__meta">{formatUpdated(p.updated)}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function formatUpdated(s?: string): string {
  if (!s) return "Untitled project";
  const t = Date.parse(s);
  if (Number.isNaN(t)) return s;
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "Edited just now";
  if (min < 60) return `Edited ${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `Edited ${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `Edited ${day} day${day > 1 ? "s" : ""} ago`;
  return `Edited ${new Date(t).toLocaleDateString()}`;
}
