import { useMemo, useState } from "react";
import { api } from "../../api";
import type { EditDoc, Track } from "../../types";
import { toast } from "../../toast";
import { ArcLogo, ThemeToggle } from "./bits";
import type { ArcTheme } from "./theme";

type BgType = "solid" | "image" | "looped" | "gradient" | "animated";

interface Draft {
  name: string;
  aspect: "16:9" | "4:3";
  bgType: BgType;
  bgColor: string;
  fps: number;
  segments: number;
  segmentSeconds: number;
  videoTracks: number;
  audioTrack: boolean;
  subtitleTrack: boolean;
}

const STEPS = ["Project", "Canvas", "Timeline", "Tracks"] as const;

const BG_OPTIONS: { id: BgType; title: string; sub: string; swatch: string }[] = [
  { id: "solid", title: "Solid color", sub: "A clean, single-color canvas", swatch: "#111827" },
  { id: "image", title: "Image", sub: "Use a still image as the canvas", swatch: "linear-gradient(135deg,#5b6b8c,#3dd0c0)" },
  { id: "looped", title: "Looped video", sub: "Repeat a video behind all tracks", swatch: "#1c2233" },
  { id: "gradient", title: "Gradient", sub: "Blend two colors across the canvas", swatch: "linear-gradient(135deg,#6366f1,#3ddc97)" },
  { id: "animated", title: "Animated gradient", sub: "Continuously shift between two colors", swatch: "linear-gradient(135deg,#8b5cf6,#3ddc97)" },
];

const CANVAS_SIZE: Record<Draft["aspect"], { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
};

export function NewProjectWizard({
  theme,
  onToggleTheme,
  onCancel,
  onCreated,
}: {
  theme: ArcTheme;
  onToggleTheme: () => void;
  onCancel: () => void;
  onCreated: (id: string) => void;
}) {
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState<Draft>({
    name: "Untitled video",
    aspect: "16:9",
    bgType: "solid",
    bgColor: "#111827",
    fps: 30,
    segments: 1,
    segmentSeconds: 10,
    videoTracks: 2,
    audioTrack: true,
    subtitleTrack: true,
  });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const size = CANVAS_SIZE[d.aspect];
  const showColor = d.bgType === "solid" || d.bgType === "gradient" || d.bgType === "animated";

  const create = async () => {
    setBusy(true);
    try {
      const doc = await api.createProject(d.name.trim() || "Untitled video");
      const tracks: Track[] = [
        { id: "t_bg", kind: "background", name: "Background", backgroundColor: showColor ? d.bgColor : "#000000" },
      ];
      const n = Math.max(1, Math.min(6, d.videoTracks));
      for (let i = 0; i < n; i++) {
        tracks.push({ id: i === 0 ? "t_video" : `t_video${i + 1}`, kind: "video", name: n > 1 ? `Video ${i + 1}` : "Video" });
      }
      tracks.push({ id: "t_overlay", kind: "overlay", name: "Overlay" });
      if (d.audioTrack) tracks.push({ id: "t_music", kind: "audio", name: "Music" });
      if (d.subtitleTrack) tracks.push({ id: "t_caption", kind: "caption", name: "Captions" });

      const next: EditDoc = {
        ...doc,
        canvas: { width: size.w, height: size.h, fps: d.fps },
        tracks,
      };
      await api.saveProject(next);
      onCreated(doc.id);
    } catch (e: any) {
      toast.error(e?.message || "Could not create project");
      setBusy(false);
    }
  };

  const next = () => (step < STEPS.length - 1 ? setStep(step + 1) : create());
  const prev = () => (step === 0 ? onCancel() : setStep(step - 1));

  return (
    <div className="arc-wizard">
      <div className="arc-topbar">
        <button className="arc-back" onClick={prev} disabled={busy}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 18l-6-6 6-6" />
          </svg>
          Back
        </button>
        <div className="arc-topbar__title">
          <ArcLogo size={34} />
          <h2>New project</h2>
        </div>
        <div className="arc-topbar__right">
          <span className="arc-topbar__step">Step {step + 1} of {STEPS.length}</span>
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        </div>
      </div>

      <Stepper step={step} />

      <div className="arc-wizard__stage">
        <div className="arc-wizard-card">
          <div className="arc-wizard-card__body">
            {step === 0 && <StepProject d={d} set={set} />}
            {step === 1 && <StepCanvas d={d} set={set} showColor={showColor} size={size} />}
            {step === 2 && <StepTimeline d={d} set={set} />}
            {step === 3 && <StepTracks d={d} set={set} />}
          </div>
          <div className="arc-wizard-card__foot">
            <span className="arc-wizard-card__hint">Nothing is permanent — settings remain editable.</span>
            <div className="arc-spacer" />
            <button className="arc-btn" onClick={prev} disabled={busy}>
              {step === 0 ? "Cancel" : "← Previous"}
            </button>
            <button className="arc-btn arc-btn--primary" onClick={next} disabled={busy}>
              {step === STEPS.length - 1 ? (busy ? "Creating…" : "Create project →") : "Continue →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="arc-stepper">
      {STEPS.map((label, i) => (
        <StepNode key={label} label={label} index={i} step={step} last={i === STEPS.length - 1} />
      ))}
    </div>
  );
}

function StepNode({ label, index, step, last }: { label: string; index: number; step: number; last: boolean }) {
  const state = index < step ? "done" : index === step ? "current" : "todo";
  return (
    <>
      <div className={`arc-step arc-step--${state}`}>
        <span className="arc-step__dot">
          {state === "done" ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            index + 1
          )}
        </span>
        <span className="arc-step__label">{label}</span>
      </div>
      {!last && <span className={`arc-step__line${index < step ? " arc-step__line--done" : ""}`} />}
    </>
  );
}

type SetFn = <K extends keyof Draft>(k: K, v: Draft[K]) => void;

function StepHead({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="arc-wizard-card__head">
      <p className="arc-eyebrow arc-eyebrow--muted">{eyebrow}</p>
      <h2 className="arc-h2">{title}</h2>
      <p className="arc-sub">{sub}</p>
    </div>
  );
}

function StepProject({ d, set }: { d: Draft; set: SetFn }) {
  return (
    <>
      <StepHead eyebrow="Start a project" title="Name your video" sub="This name is used in your project library and can be changed later." />
      <div className="arc-form">
        <div className="arc-field">
          <label className="arc-label" htmlFor="arc-name">Project name</label>
          <input
            id="arc-name"
            className="arc-input"
            value={d.name}
            autoFocus
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
      </div>
    </>
  );
}

function StepCanvas({
  d,
  set,
  showColor,
  size,
}: {
  d: Draft;
  set: SetFn;
  showColor: boolean;
  size: { w: number; h: number };
}) {
  const previewStyle = useMemo(() => {
    const ratio = d.aspect === "16:9" ? "16 / 9" : "4 / 3";
    let bg = d.bgColor;
    if (d.bgType === "gradient") bg = `linear-gradient(135deg, ${d.bgColor}, #3ddc97)`;
    else if (d.bgType === "animated") bg = `linear-gradient(135deg, ${d.bgColor}, #8b5cf6)`;
    else if (d.bgType === "image" || d.bgType === "looped") bg = "linear-gradient(135deg,#334155,#1e293b)";
    return { aspectRatio: ratio, width: "100%", maxWidth: 520, background: bg } as React.CSSProperties;
  }, [d.aspect, d.bgType, d.bgColor]);

  return (
    <>
      <StepHead eyebrow="Canvas setup" title="Choose the shape and background" sub="Your canvas controls composition. Export resolution is selected later when you render." />
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="arc-split">
          <div>
            <div className="arc-step-section__label">Canvas shape</div>
            <div className="arc-step-section__hint">Choose the frame your content is composed inside.</div>
          </div>
          <div className="arc-tiles">
            <ShapeTile on={d.aspect === "16:9"} onClick={() => set("aspect", "16:9")} title="16:9" sub="Widescreen" w={30} h={17} />
            <ShapeTile on={d.aspect === "4:3"} onClick={() => set("aspect", "4:3")} title="4:3" sub="Classic" w={24} h={18} />
          </div>
        </div>

        <div className="arc-split">
          <div>
            <div className="arc-step-section__label">Canvas background</div>
            <div className="arc-step-section__hint">This sits behind every video layer and can be changed later.</div>
          </div>
          <div>
            {BG_OPTIONS.map((o) => (
              <button
                key={o.id}
                type="button"
                className={`arc-option${d.bgType === o.id ? " arc-option--on" : ""}`}
                onClick={() => set("bgType", o.id)}
              >
                <span className="arc-option__swatch" style={{ background: o.swatch }} />
                <span className="arc-option__body">
                  <span className="arc-option__title">{o.title}</span>
                  <span className="arc-option__sub">{o.sub}</span>
                </span>
              </button>
            ))}

            {showColor && (
              <div className="arc-field" style={{ marginTop: 16 }}>
                <label className="arc-label">Background color</label>
                <div className="arc-color-row">
                  <input type="color" value={d.bgColor} onChange={(e) => set("bgColor", e.target.value)} aria-label="Background color" />
                  <input
                    className="arc-input"
                    value={d.bgColor}
                    onChange={(e) => set("bgColor", e.target.value)}
                  />
                </div>
              </div>
            )}

            <div className="arc-canvas-preview" style={previewStyle}>
              <span>{d.aspect} canvas preview · {size.w}×{size.h}</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function ShapeTile({ on, onClick, title, sub, w, h }: { on: boolean; onClick: () => void; title: string; sub: string; w: number; h: number }) {
  return (
    <button type="button" className={`arc-tile${on ? " arc-tile--on" : ""}`} onClick={onClick}>
      <span className="arc-tile__glyph" style={{ width: 44, height: 34 }}>
        <i style={{ width: w, height: h }} />
      </span>
      <span>
        <span className="arc-tile__title">{title}</span>
        <span className="arc-tile__sub">{sub}</span>
      </span>
    </button>
  );
}

function StepTimeline({ d, set }: { d: Draft; set: SetFn }) {
  return (
    <>
      <StepHead eyebrow="Timeline basics" title="Set up your starting timeline" sub="Segments combine in order to create the complete video." />
      <div className="arc-form">
        <div className="arc-field">
          <label className="arc-label" htmlFor="arc-fps">Frame rate</label>
          <select id="arc-fps" className="arc-select" value={d.fps} onChange={(e) => set("fps", Number(e.target.value))}>
            <option value={24}>24 fps — cinematic</option>
            <option value={30}>30 fps — recommended</option>
            <option value={60}>60 fps — smooth motion</option>
          </select>
        </div>
        <div className="arc-grid-2">
          <div className="arc-field">
            <label className="arc-label" htmlFor="arc-seg">Starting segments</label>
            <input id="arc-seg" className="arc-input" type="number" min={1} max={20} value={d.segments} onChange={(e) => set("segments", clampInt(e.target.value, 1, 20))} />
          </div>
          <div className="arc-field">
            <label className="arc-label" htmlFor="arc-segdur">Each segment (seconds)</label>
            <input id="arc-segdur" className="arc-input" type="number" min={1} max={600} value={d.segmentSeconds} onChange={(e) => set("segmentSeconds", clampInt(e.target.value, 1, 600))} />
          </div>
        </div>
      </div>
    </>
  );
}

function StepTracks({ d, set }: { d: Draft; set: SetFn }) {
  return (
    <>
      <StepHead eyebrow="Starter tracks" title="Which tracks do you need?" sub="You can add and remove tracks anytime in the editor." />
      <div className="arc-form">
        <div className="arc-field">
          <label className="arc-label" htmlFor="arc-vtracks">Video tracks</label>
          <input id="arc-vtracks" className="arc-input" type="number" min={1} max={6} value={d.videoTracks} onChange={(e) => set("videoTracks", clampInt(e.target.value, 1, 6))} />
        </div>
        <button type="button" className={`arc-option${d.audioTrack ? " arc-option--on" : ""}`} onClick={() => set("audioTrack", !d.audioTrack)}>
          <span className="arc-option__body">
            <span className="arc-option__title">Audio track</span>
            <span className="arc-option__sub">Music, voice, and sound effects</span>
          </span>
          <Check />
        </button>
        <button type="button" className={`arc-option${d.subtitleTrack ? " arc-option--on" : ""}`} onClick={() => set("subtitleTrack", !d.subtitleTrack)}>
          <span className="arc-option__body">
            <span className="arc-option__title">Subtitle track</span>
            <span className="arc-option__sub">Captions burned into the final video</span>
          </span>
          <Check />
        </button>
      </div>
    </>
  );
}

function Check() {
  return (
    <span className="arc-check">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    </span>
  );
}

function clampInt(v: string, lo: number, hi: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}
