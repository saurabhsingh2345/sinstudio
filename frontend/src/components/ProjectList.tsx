import { useEffect, useMemo, useRef, useState } from "react";
import { api, type ProjectMeta } from "../api";
import { toast } from "../toast";
import { ArcLogo, ThemeToggle } from "./arc/bits";
import { useArcTheme } from "./arc/theme";
import { NewProjectWizard } from "./arc/NewProjectWizard";

type SortKey = "recent" | "name";

export function ProjectList({ onOpen }: { onOpen: (id: string) => void }) {
  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortKey>("recent");
  const [theme, toggleTheme] = useArcTheme();
  const recentRef = useRef<HTMLDivElement>(null);

  const refresh = () => api.listProjects().then(setProjects).catch(console.error);
  useEffect(() => {
    refresh();
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

  // Filter then sort, so the sort order applies to what's on screen rather than
  // to a list the search has already hidden most of.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects.slice();
    if (sort === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    } else {
      list.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
    }
    return list;
  }, [projects, query, sort]);

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
            <div className="arc-recent__head">
              <div>
                <p className="arc-eyebrow arc-eyebrow--muted arc-recent__label">Recent</p>
                <h3 className="arc-recent__title">
                  Your projects
                  {projects.length > 0 && <span className="arc-count">{projects.length}</span>}
                </h3>
              </div>

              {projects.length > 0 && (
                <div className="arc-recent__tools">
                  <div className="arc-search">
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                      <circle cx="11" cy="11" r="7" />
                      <path d="M20 20l-3.5-3.5" />
                    </svg>
                    <input
                      type="search"
                      value={query}
                      placeholder="Search projects"
                      aria-label="Search projects"
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <select
                    className="arc-select"
                    value={sort}
                    aria-label="Sort projects"
                    onChange={(e) => setSort(e.target.value as SortKey)}
                  >
                    <option value="recent">Last edited</option>
                    <option value="name">Name (A–Z)</option>
                  </select>
                </div>
              )}
            </div>

            {projects.length === 0 ? (
              <div className="arc-empty">Your recently opened projects will appear here.</div>
            ) : shown.length === 0 ? (
              <div className="arc-empty">No projects match “{query.trim()}”.</div>
            ) : (
              <div className="arc-projects">
                {shown.map((p) => (
                  <ProjectCard key={p.id} project={p} onOpen={onOpen} onChanged={refresh} />
                ))}
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

// A card is in exactly one of these states: the menu and the destructive
// confirmations are mutually exclusive on purpose, so a card can never show a
// rename field and a delete prompt at the same time.
type CardMode =
  | { kind: "idle" }
  | { kind: "rename" }
  | { kind: "confirmDelete" }
  | { kind: "busy"; label: string };

function ProjectCard({
  project,
  onOpen,
  onChanged,
}: {
  project: ProjectMeta;
  onOpen: (id: string) => void;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<CardMode>({ kind: "idle" });
  const [menuOpen, setMenuOpen] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const cardRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  // Enter submits the form and then blurs the field, so without this the rename
  // would be sent twice.
  const renameSent = useRef(false);

  // Close the menu on an outside click or Escape — a popover that only closes
  // by choosing something is a trap.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!cardRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (mode.kind === "rename") renameRef.current?.select();
  }, [mode.kind]);

  const busy = mode.kind === "busy";

  const startRename = () => {
    setDraft(project.name);
    setMenuOpen(false);
    renameSent.current = false;
    setMode({ kind: "rename" });
  };

  const cancelRename = () => {
    renameSent.current = true;
    setMode({ kind: "idle" });
  };

  const commitRename = async () => {
    if (renameSent.current) return;
    renameSent.current = true;
    const name = draft.trim();
    if (!name || name === project.name) {
      setMode({ kind: "idle" });
      return;
    }
    setMode({ kind: "busy", label: "Renaming…" });
    try {
      await api.renameProject(project.id, name);
      onChanged();
    } catch (err) {
      toast.error(`Rename failed: ${(err as Error).message}`);
    } finally {
      setMode({ kind: "idle" });
    }
  };

  const duplicate = async () => {
    setMenuOpen(false);
    // The server copies the media, so this is not instant on a big project —
    // say so rather than leaving the card looking unresponsive.
    setMode({ kind: "busy", label: "Duplicating…" });
    try {
      const copy = await api.duplicateProject(project.id);
      onChanged();
      toast.success(`Created “${copy.name}”`);
    } catch (err) {
      toast.error(`Duplicate failed: ${(err as Error).message}`);
    } finally {
      setMode({ kind: "idle" });
    }
  };

  const confirmDelete = async () => {
    setMode({ kind: "busy", label: "Deleting…" });
    try {
      await api.deleteProject(project.id);
      onChanged();
      toast.info(`Deleted “${project.name}”`);
    } catch (err) {
      toast.error(`Delete failed: ${(err as Error).message}`);
      setMode({ kind: "idle" });
    }
  };

  if (mode.kind === "confirmDelete") {
    return (
      <div className="arc-pcard arc-pcard--confirm" ref={cardRef}>
        <p className="arc-pcard__confirm-title">Delete “{project.name}”?</p>
        <p className="arc-pcard__confirm-note">
          Its timeline and every imported, generated and exported file go with it. This can’t be undone.
        </p>
        <div className="arc-pcard__confirm-row">
          <button className="arc-btn arc-btn--sm arc-btn--ghost" onClick={() => setMode({ kind: "idle" })}>
            Cancel
          </button>
          <button className="arc-btn arc-btn--sm arc-btn--danger" onClick={() => void confirmDelete()}>
            Delete project
          </button>
        </div>
      </div>
    );
  }

  if (mode.kind === "rename") {
    return (
      <div className="arc-pcard arc-pcard--editing" ref={cardRef}>
        <ProjectThumb />
        <form
          className="arc-pcard__rename"
          onSubmit={(e) => {
            e.preventDefault();
            void commitRename();
          }}
        >
          <input
            ref={renameRef}
            className="arc-input arc-input--sm"
            value={draft}
            aria-label="Project name"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancelRename();
            }}
            onBlur={() => void commitRename()}
          />
          <span className="arc-pcard__hint">Enter to save · Esc to cancel</span>
        </form>
      </div>
    );
  }

  return (
    <div
      className={`arc-pcard${busy ? " arc-pcard--busy" : ""}${menuOpen ? " arc-pcard--menu" : ""}`}
      ref={cardRef}
    >
      <button className="arc-pcard__open" onClick={() => onOpen(project.id)} disabled={busy}>
        <ProjectThumb />
        <span style={{ minWidth: 0 }}>
          <span className="arc-pcard__name">{project.name}</span>
          <span className="arc-pcard__meta">
            {busy ? mode.label : formatUpdated(project.updated)}
          </span>
        </span>
      </button>

      {!busy && (
        <div className="arc-pcard__actions">
          <button
            className="arc-icon-btn"
            aria-label={`Actions for ${project.name}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.8" />
              <circle cx="12" cy="12" r="1.8" />
              <circle cx="19" cy="12" r="1.8" />
            </svg>
          </button>

          {menuOpen && (
            <div className="arc-menu" role="menu">
              <button className="arc-menu__item" role="menuitem" onClick={() => onOpen(project.id)}>
                Open
              </button>
              <button className="arc-menu__item" role="menuitem" onClick={startRename}>
                Rename…
              </button>
              <button className="arc-menu__item" role="menuitem" onClick={() => void duplicate()}>
                Duplicate
              </button>
              <div className="arc-menu__sep" />
              <button
                className="arc-menu__item arc-menu__item--danger"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setMode({ kind: "confirmDelete" });
                }}
              >
                Delete…
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ProjectThumb() {
  return (
    <span className="arc-pcard__thumb">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M10 9l5 3-5 3V9Z" fill="currentColor" stroke="none" />
      </svg>
    </span>
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
