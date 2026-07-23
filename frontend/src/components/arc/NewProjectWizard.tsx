import { useMemo, useState } from "react";
import { api } from "../../api";
import type { Clip, EditDoc, Track } from "../../types";
import { newId } from "../../types";
import { toast } from "../../toast";
import { trackBackgroundCSS } from "../../trackBackground";
import { PROJECT_TEMPLATES } from "../../projectTemplates";
import { ArcLogo, ThemeToggle } from "./bits";
import type { ArcTheme } from "./theme";

type BgType = "solid" | "gradient";
type WizardAspect = "16:9" | "4:3" | "9:16";

interface Draft {
  name: string;
  aspect: WizardAspect;
  bgType: BgType;
  bgColor: string;
  bgColor2: string;
  fps: number;
  segments: number;
  segmentSeconds: number;
  videoTracks: number;
  audioTrack: boolean;
  subtitleTrack: boolean;
}

const STEPS = ["Template", "Project", "Canvas", "Timeline", "Tracks"] as const;

const BG_OPTIONS: { id: BgType; title: string; sub: string; swatch: string }[] = [
  { id: "solid", title: "Solid color", sub: "A clean, single-color canvas", swatch: "#111827" },
  { id: "gradient", title: "Gradient", sub: "Blend two colors top to bottom", swatch: "linear-gradient(180deg,#6366f1,#3ddc97)" },
];

const CANVAS_SIZE: Record<Draft["aspect"], { w: number; h: number }> = {
  "16:9": { w: 1920, h: 1080 },
  "4:3": { w: 1440, h: 1080 },
  "9:16": { w: 1080, h: 1920 },
};

function buildBackgroundTrack(d: Draft): Track {
  const track: Track = {
    id: "t_bg",
    kind: "background",
    name: "Background",
    backgroundColor: d.bgColor,
  };
  if (d.bgType === "gradient") {
    track.backgroundColor2 = d.bgColor2 || "#3ddc97";
  }
  return track;
}

function buildSegmentClips(segments: number, segmentSeconds: number): Clip[] {
  const clips: Clip[] = [];
  let start = 0;
  for (let i = 0; i < segments; i++) {
    clips.push({
      id: newId("seg_"),
      assetId: "",
      start,
      in: 0,
      out: segmentSeconds,
      transform: { x: 0, y: 0, scale: 1, opacity: 1 },
      volume: 0,
      title: {
        text: segments > 1 ? `Segment ${i + 1}` : "Your clip here",
        size: segments > 1 ? 56 : 72,
        color: "#ffffff66",
        align: "center",
        posY: 0.5,
      },
    });
    start += segmentSeconds;
  }
  return clips;
}

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
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0].id);
  const [d, setD] = useState<Draft>(PROJECT_TEMPLATES[0].draft as Draft);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const applyTemplate = (id: string) => {
    setTemplateId(id);
    const t = PROJECT_TEMPLATES.find((x) => x.id === id);
    if (t) setD(t.draft as Draft);
  };

  const size = CANVAS_SIZE[d.aspect];

  const create = async () => {
    setBusy(true);
    try {
      const doc = await api.createProject(d.name.trim() || "Untitled video");
      const tracks: Track[] = [buildBackgroundTrack(d)];
      const n = Math.max(1, Math.min(6, d.videoTracks));
      const segmentClips = buildSegmentClips(d.segments, d.segmentSeconds);
      for (let i = 0; i < n; i++) {
        tracks.push({
          id: i === 0 ? "t_video" : `t_video${i + 1}`,
          kind: "video",
          name: n > 1 ? `Video ${i + 1}` : "Video",
          clips: i === 0 ? segmentClips : [],
        });
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
            {step === 0 && <StepTemplate templateId={templateId} onPick={applyTemplate} />}
            {step === 1 && <StepProject d={d} set={set} />}
            {step === 2 && <StepCanvas d={d} set={set} size={size} />}
            {step === 3 && <StepTimeline d={d} set={set} />}
            {step === 4 && <StepTracks d={d} set={set} />}
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

function StepTemplate({ templateId, onPick }: { templateId: string; onPick: (id: string) => void }) {
  return (
    <>
      <StepHead
        eyebrow="Start faster"
        title="Pick a template"
        sub="Pre-configures canvas shape, tracks and background — everything stays editable."
      />
      <div className="arc-tiles" style={{ maxWidth: 720 }}>
        {PROJECT_TEMPLATES.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`arc-option${templateId === t.id ? " arc-option--on" : ""}`}
            onClick={() => onPick(t.id)}
          >
            <span className="arc-option__swatch" style={{ background: t.swatch }} />
            <span className="arc-option__body">
              <span className="arc-option__title">{t.name}</span>
              <span className="arc-option__sub">{t.description}</span>
            </span>
          </button>
        ))}
      </div>
    </>
  );
}

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
  size,
}: {
  d: Draft;
  set: SetFn;
  size: { w: number; h: number };
}) {
  const previewStyle = useMemo(() => {
    const ratio = d.aspect === "16:9" ? "16 / 9" : d.aspect === "9:16" ? "9 / 16" : "4 / 3";
    const bgTrack = buildBackgroundTrack(d);
    return {
      aspectRatio: ratio,
      width: "100%",
      maxWidth: 520,
      background: trackBackgroundCSS(bgTrack, d.bgColor),
    } as React.CSSProperties;
  }, [d]);

  return (
    <>
      <StepHead eyebrow="Canvas setup" title="Choose the shape and background" sub="Your canvas controls composition. Import images or looped video to the Background track after creating." />
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        <div className="arc-split">
          <div>
            <div className="arc-step-section__label">Canvas shape</div>
            <div className="arc-step-section__hint">Choose the frame your content is composed inside.</div>
          </div>
          <div className="arc-tiles">
            <ShapeTile on={d.aspect === "16:9"} onClick={() => set("aspect", "16:9")} title="16:9" sub="Widescreen" w={30} h={17} />
            <ShapeTile on={d.aspect === "4:3"} onClick={() => set("aspect", "4:3")} title="4:3" sub="Classic" w={24} h={18} />
            <ShapeTile on={d.aspect === "9:16"} onClick={() => set("aspect", "9:16")} title="9:16" sub="Vertical" w={17} h={30} />
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

            <div className="arc-field" style={{ marginTop: 16 }}>
              <label className="arc-label">{d.bgType === "gradient" ? "Top color" : "Background color"}</label>
              <div className="arc-color-row">
                <input type="color" value={d.bgColor} onChange={(e) => set("bgColor", e.target.value)} aria-label="Background color" />
                <input className="arc-input" value={d.bgColor} onChange={(e) => set("bgColor", e.target.value)} />
              </div>
            </div>

            {d.bgType === "gradient" && (
              <div className="arc-field" style={{ marginTop: 12 }}>
                <label className="arc-label">Bottom color</label>
                <div className="arc-color-row">
                  <input type="color" value={d.bgColor2} onChange={(e) => set("bgColor2", e.target.value)} aria-label="Gradient end color" />
                  <input className="arc-input" value={d.bgColor2} onChange={(e) => set("bgColor2", e.target.value)} />
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
  const totalSeconds = d.segments * d.segmentSeconds;
  return (
    <>
      <StepHead eyebrow="Timeline basics" title="Set up your starting timeline" sub="Placeholder segments land on the first video track — replace them with recordings or imports." />
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
        <p className="arc-sub" style={{ marginTop: 8 }}>
          Timeline length: {totalSeconds}s ({d.segments} segment{d.segments === 1 ? "" : "s"} × {d.segmentSeconds}s)
        </p>
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
