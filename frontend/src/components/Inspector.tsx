import { useStudio } from "../state";
import type { Keyframe, Transition } from "../types";

export function Inspector() {
  const {
    doc,
    selClip,
    selCue,
    updateClip,
    removeClip,
    updateCue,
    removeCue,
    setBackground,
    playhead,
    addKeyframe,
    updateKeyframe,
    removeKeyframe,
    updateEffect,
    resetEffects,
    updateTitle,
    selClips,
    deleteSelected,
  } = useStudio();
  if (!doc) return null;
  const multi = selClips.length > 1;

  const clip = selClip
    ? doc.tracks.find((t) => t.id === selClip.trackId)?.clips?.find((c) => c.id === selClip.clipId)
    : null;
  const cue = selCue
    ? doc.tracks.find((t) => t.kind === "caption")?.cues?.find((c) => c.id === selCue)
    : null;

  return (
    <>
      <div className="panel-h">Inspector</div>
      <div className="inspector" style={{ padding: 12 }}>
        {multi && (
          <>
            <div className="small">{selClips.length} clips selected</div>
            <div className="muted" style={{ fontSize: 11, margin: "8px 0" }}>
              Drag any selected clip to move them together. Shift-click to add/remove.
            </div>
            <button
              className="primary"
              style={{ background: "var(--danger)", borderColor: "var(--danger)" }}
              onClick={deleteSelected}
            >
              Delete {selClips.length} clips
            </button>
          </>
        )}
        {!multi && clip && selClip && (
          <>
            <div className="small">
              {clip.title ? "Title clip" : "Clip · " + (doc.assets.find((a) => a.id === clip.assetId)?.name ?? "")}
            </div>
            <Num label="Start (s)" v={clip.start} on={(x) => updateClip(selClip.trackId, clip.id, { start: x })} />
            {clip.title ? (
              <>
                <div className="field">
                  <label>Text</label>
                  <textarea value={clip.title.text} rows={2} onChange={(e) => updateTitle(selClip.trackId, clip.id, { text: e.target.value })} />
                </div>
                <div className="row">
                  <Num label="Size" v={clip.title.size} step={2} on={(x) => updateTitle(selClip.trackId, clip.id, { size: x })} />
                  <div className="field">
                    <label>Color</label>
                    <input type="color" value={clip.title.color} onChange={(e) => updateTitle(selClip.trackId, clip.id, { color: e.target.value })} />
                  </div>
                </div>
                <div className="row">
                  <div className="field">
                    <label>Align</label>
                    <select value={clip.title.align ?? "center"} onChange={(e) => updateTitle(selClip.trackId, clip.id, { align: e.target.value as "left" | "center" | "right" })}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  <Num label="Vertical (0–1)" v={clip.title.posY} step={0.02} on={(x) => updateTitle(selClip.trackId, clip.id, { posY: x })} />
                </div>
                <div className="row">
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={!!clip.title.bold} onChange={(e) => updateTitle(selClip.trackId, clip.id, { bold: e.target.checked })} />
                    Bold
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                    <input type="checkbox" checked={!!clip.title.background} onChange={(e) => updateTitle(selClip.trackId, clip.id, { background: e.target.checked ? "#000000" : "" })} />
                    Band
                  </label>
                  {clip.title.background && (
                    <input type="color" value={clip.title.background} onChange={(e) => updateTitle(selClip.trackId, clip.id, { background: e.target.value })} />
                  )}
                </div>
                <Num label="Duration (s)" v={clip.out} step={0.5} on={(x) => updateClip(selClip.trackId, clip.id, { out: Math.max(0.2, x) })} />
              </>
            ) : (
              <>
                <div className="row">
                  <Num label="Trim in" v={clip.in} on={(x) => updateClip(selClip.trackId, clip.id, { in: x })} />
                  <Num label="Trim out" v={clip.out} on={(x) => updateClip(selClip.trackId, clip.id, { out: x })} />
                </div>
                <Num label="Volume" v={clip.volume} step={0.05} on={(x) => updateClip(selClip.trackId, clip.id, { volume: x })} />
                <Num label="Speed (×)" v={clip.speed ?? 1} step={0.1} on={(x) => updateClip(selClip.trackId, clip.id, { speed: x })} />
              </>
            )}
            <div className="row">
              <Num label="Fade in (s)" v={clip.fadeIn ?? 0} step={0.1} on={(x) => updateClip(selClip.trackId, clip.id, { fadeIn: x })} />
              <Num label="Fade out (s)" v={clip.fadeOut ?? 0} step={0.1} on={(x) => updateClip(selClip.trackId, clip.id, { fadeOut: x })} />
            </div>
            <Trans label="Transition in" v={clip.transitionIn} on={(tr) => updateClip(selClip.trackId, clip.id, { transitionIn: tr })} />
            <Trans label="Transition out" v={clip.transitionOut} on={(tr) => updateClip(selClip.trackId, clip.id, { transitionOut: tr })} />
            <div className="row">
              <Num label="Scale" v={clip.transform.scale} step={0.05} on={(x) => updateClip(selClip.trackId, clip.id, { transform: { ...clip.transform, scale: x } })} />
              <Num label="Opacity" v={clip.transform.opacity} step={0.05} on={(x) => updateClip(selClip.trackId, clip.id, { transform: { ...clip.transform, opacity: x } })} />
            </div>
            <div className="row">
              <Num label="X" v={clip.transform.x} step={5} on={(x) => updateClip(selClip.trackId, clip.id, { transform: { ...clip.transform, x } })} />
              <Num label="Y" v={clip.transform.y} step={5} on={(x) => updateClip(selClip.trackId, clip.id, { transform: { ...clip.transform, y: x } })} />
            </div>

            <div className="kf-head">
              Motion keyframes
              <span className="small"> · key X/Y at the playhead to animate position</span>
            </div>
            {(["x", "y", "opacity"] as const).map((prop) => (
              <KeyRow
                key={prop}
                prop={prop}
                keys={clip.keyframes?.[prop] ?? []}
                localPlayhead={+(playhead - clip.start).toFixed(2)}
                onAdd={() => addKeyframe(selClip.trackId, clip.id, prop)}
                onUpdate={(i, v) => updateKeyframe(selClip.trackId, clip.id, prop, i, v)}
                onRemove={(i) => removeKeyframe(selClip.trackId, clip.id, prop, i)}
              />
            ))}

            <div className="kf-head">
              Effects
              <div className="spacer" />
              {clip.effects && (
                <button className="ghost" onClick={() => resetEffects(selClip.trackId, clip.id)} title="Clear all effects">
                  reset
                </button>
              )}
            </div>
            <Slider label="Brightness" v={clip.effects?.brightness ?? 0} min={-1} max={1} step={0.02} def={0} on={(x) => updateEffect(selClip.trackId, clip.id, "brightness", x)} />
            <Slider label="Contrast" v={clip.effects?.contrast ?? 1} min={0} max={2} step={0.02} def={1} on={(x) => updateEffect(selClip.trackId, clip.id, "contrast", x)} />
            <Slider label="Saturation" v={clip.effects?.saturation ?? 1} min={0} max={3} step={0.02} def={1} on={(x) => updateEffect(selClip.trackId, clip.id, "saturation", x)} />
            <Slider label="Hue (°)" v={clip.effects?.hue ?? 0} min={-180} max={180} step={1} def={0} on={(x) => updateEffect(selClip.trackId, clip.id, "hue", x)} />
            <Slider label="Blur" v={clip.effects?.blur ?? 0} min={0} max={30} step={0.5} def={0} on={(x) => updateEffect(selClip.trackId, clip.id, "blur", x)} />
            <button className="primary" style={{ marginTop: 10, background: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => removeClip(selClip.trackId, clip.id)}>
              Delete clip
            </button>
          </>
        )}

        {cue && (
          <>
            <div className="small">Caption cue</div>
            <label>Text</label>
            <textarea value={cue.text} rows={2} onChange={(e) => updateCue(cue.id, { text: e.target.value })} />
            <div className="row">
              <Num label="Start" v={cue.start} on={(x) => updateCue(cue.id, { start: x })} />
              <Num label="End" v={cue.end} on={(x) => updateCue(cue.id, { end: x })} />
            </div>
            <div className="row">
              <Num label="Size" v={cue.style.size} step={1} on={(x) => updateCue(cue.id, { style: { ...cue.style, size: x } })} />
              <div>
                <label>Color</label>
                <input type="color" value={cue.style.color} onChange={(e) => updateCue(cue.id, { style: { ...cue.style, color: e.target.value } })} />
              </div>
            </div>
            <Num label="Vertical pos (0–1)" v={cue.style.posY} step={0.02} on={(x) => updateCue(cue.id, { style: { ...cue.style, posY: x } })} />
            <button className="primary" style={{ marginTop: 10, background: "var(--danger)", borderColor: "var(--danger)" }} onClick={() => removeCue(cue.id)}>
              Delete cue
            </button>
          </>
        )}

        {!clip && !cue && (
          <>
            <div className="small">Project</div>
            <label>Background color</label>
            <input
              type="color"
              value={doc.tracks.find((t) => t.kind === "background")?.backgroundColor || "#000000"}
              onChange={(e) => setBackground(e.target.value)}
            />
            <div className="small" style={{ marginTop: 12 }}>
              Select a clip or caption to edit it. Click an asset to add it at the playhead, or drag it
              onto a track.
            </div>
          </>
        )}
      </div>
    </>
  );
}

// KeyRow lists one property's keyframes with add/edit/delete. The playhead time
// is clip-local so "◆ key" captures the current transform value at that moment.
function KeyRow({
  prop,
  keys,
  localPlayhead,
  onAdd,
  onUpdate,
  onRemove,
}: {
  prop: "x" | "y" | "opacity";
  keys: Keyframe[];
  localPlayhead: number;
  onAdd: () => void;
  onUpdate: (i: number, v: number) => void;
  onRemove: (i: number) => void;
}) {
  const step = prop === "opacity" ? 0.05 : 5;
  const label = prop === "opacity" ? "O" : prop.toUpperCase();
  return (
    <div className="kf-row">
      <div className="kf-label">
        <b title={prop}>{label}</b>
        <button className="ghost" onClick={onAdd} title={`Key ${prop} at playhead (${localPlayhead}s)`}>
          ◆ key
        </button>
      </div>
      {keys.length === 0 ? (
        <span className="small kf-empty">no keys</span>
      ) : (
        <div className="kf-chips">
          {keys.map((k, i) => (
            <span className="kf-chip" key={i}>
              <span className="kf-t">{k.t.toFixed(2)}s</span>
              <input
                type="number"
                step={step}
                value={+k.value.toFixed(2)}
                onChange={(e) => onUpdate(i, parseFloat(e.target.value) || 0)}
              />
              <button className="kf-x" onClick={() => onRemove(i)} title="Remove keyframe">
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

const TRANS_OPTS = [
  { v: "", label: "None" },
  { v: "fade", label: "Fade" },
  { v: "dissolve", label: "Dissolve (crossfade)" },
  { v: "slide-left", label: "Slide ← from left" },
  { v: "slide-right", label: "Slide → from right" },
  { v: "slide-top", label: "Slide ↑ from top" },
  { v: "slide-bottom", label: "Slide ↓ from bottom" },
];

// Trans edits a clip entrance/exit transition (type + duration). Selecting
// "None" clears it (undefined).
function Trans({
  label,
  v,
  on,
}: {
  label: string;
  v?: Transition;
  on: (t: Transition | undefined) => void;
}) {
  const type = v?.type ?? "";
  const dur = v?.duration ?? 0.5;
  return (
    <div className="field">
      <label>{label}</label>
      <div className="row">
        <select
          value={type}
          onChange={(e) => on(e.target.value ? { type: e.target.value, duration: dur } : undefined)}
        >
          {TRANS_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <input
          type="number"
          step={0.1}
          min={0.1}
          title="Duration (s)"
          disabled={!type}
          value={+dur.toFixed(2)}
          onChange={(e) => type && on({ type, duration: parseFloat(e.target.value) || 0.5 })}
        />
      </div>
    </div>
  );
}

// Slider is a labelled range with a live value and double-click-to-reset.
function Slider({
  label,
  v,
  min,
  max,
  step,
  def,
  on,
}: {
  label: string;
  v: number;
  min: number;
  max: number;
  step: number;
  def: number;
  on: (x: number) => void;
}) {
  const changed = Math.abs(v - def) > 1e-6;
  return (
    <div className="field slider">
      <label>
        {label}
        <span className={"sv" + (changed ? " on" : "")}>{+v.toFixed(2)}</span>
      </label>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={v}
        onChange={(e) => on(parseFloat(e.target.value))}
        onDoubleClick={() => on(def)}
        title="Double-click to reset"
      />
    </div>
  );
}

function Num({
  label,
  v,
  on,
  step = 0.1,
}: {
  label: string;
  v: number;
  on: (x: number) => void;
  step?: number;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <input
        type="number"
        step={step}
        value={Number.isFinite(v) ? +v.toFixed(3) : 0}
        onChange={(e) => on(parseFloat(e.target.value) || 0)}
      />
    </div>
  );
}
