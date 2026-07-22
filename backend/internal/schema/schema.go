// Package schema defines the declarative "edit document" — the single source of
// truth for a project. The browser renders an approximate live preview from it,
// and the Go export renderer compiles the same document into an authoritative
// FFmpeg render. Keep this in sync with schema/edit-document.schema.json and the
// TypeScript types in frontend/src/state.
package schema

// Canvas is the output frame geometry.
type Canvas struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	FPS    int `json:"fps"`
}

// Transform positions/scales a clip within the canvas. x/y are top-left offsets
// in canvas pixels; scale is a multiplier (1 = fit); opacity is 0..1.
type Transform struct {
	X        float64 `json:"x"`
	Y        float64 `json:"y"`
	Scale    float64 `json:"scale"`
	Opacity  float64 `json:"opacity"`
	Rotation float64 `json:"rotation,omitempty"` // clockwise degrees about the clip's center
	// AnchorX/AnchorY move the point that scaling holds fixed — the zoom origin —
	// away from the clip's center. Normalized and *relative to center*, so ±0.5 is
	// an edge and 0 is the center. Center-relative (rather than a 0..1 fraction) so
	// the zero value is the historical behavior and documents predating anchors
	// keep zooming from the middle. Rotation always pivots about the center.
	AnchorX float64 `json:"anchorX,omitempty"`
	AnchorY float64 `json:"anchorY,omitempty"`
}

// AnchorFrac returns the scale origin as a 0..1 fraction of the clip's box
// (0.5 = center), clamped. Both engines size a scaled clip so this point stays
// put: left = AnchorFracX * (canvasW - clipW).
func (t Transform) AnchorFrac() (float64, float64) {
	clamp := func(v float64) float64 {
		v += 0.5
		if v < 0 {
			return 0
		}
		if v > 1 {
			return 1
		}
		return v
	}
	return clamp(t.AnchorX), clamp(t.AnchorY)
}

// Clip is a placed reference to an asset on a track.
type Clip struct {
	ID            string      `json:"id"`
	AssetID       string      `json:"assetId"`
	Start         float64     `json:"start"` // position on the timeline (seconds)
	In            float64     `json:"in"`    // trim start within the source (seconds)
	Out           float64     `json:"out"`   // trim end within the source (seconds)
	Transform     Transform   `json:"transform"`
	Volume        float64     `json:"volume"`            // 0..1, audio gain for this clip
	Speed         float64     `json:"speed,omitempty"`   // playback rate (1 = normal); 0 treated as 1
	FadeIn        float64     `json:"fadeIn,omitempty"`  // seconds of fade-in
	FadeOut       float64     `json:"fadeOut,omitempty"` // seconds of fade-out
	TransitionIn  *Transition `json:"transitionIn,omitempty"`
	TransitionOut *Transition `json:"transitionOut,omitempty"`
	// Keyframes animate a property over the clip's life. Keyed by property name:
	// "x"/"y" (position offset in canvas px), "scale" (multiplier, 1 = canvas-fit),
	// "opacity" (0..1), "rotation" (clockwise degrees). Points are clip-local
	// seconds (from Start) so they survive moving/splitting the clip. A keyed
	// property overrides the matching static Transform field for the clip's life.
	Keyframes map[string][]Keyframe `json:"keyframes,omitempty"`
	Effects   *Effects              `json:"effects,omitempty"`
	// EQ is an optional 3-band equalizer on this clip's audio.
	EQ *AudioEQ `json:"eq,omitempty"`
	// Denoise removes broadband background noise (fans, hiss, room tone) from
	// this clip's audio. 0 = off; 0..1 sets how hard the reduction works.
	// Compiled to ffmpeg afftdn with a tracked noise floor.
	Denoise float64 `json:"denoise,omitempty"`
	// LUT names a .cube color lookup table (in the project's luts dir) applied to
	// this clip's video. Empty = none.
	LUT string `json:"lut,omitempty"`
	// Mute silences this clip's own audio in the export — used after its audio is
	// detached to a separate audio-track clip. This is distinct from Volume 0,
	// which the renderer treats as "unset" (and plays at full gain).
	Mute bool `json:"mute,omitempty"`
	// Hold appends this many seconds of the frozen last frame after the source
	// plays out, so a clip can cover trailing audio without cutting to black.
	// Added to PlayDur; the renderer extends the video with tpad=clone.
	Hold float64 `json:"hold,omitempty"`
	// SourceClip links a detached audio clip back to the video clip it came from.
	// UI grouping only; the renderer ignores it.
	SourceClip string `json:"sourceClip,omitempty"`
	// Disabled excludes this clip from the render/preview without deleting it —
	// a per-clip enable toggle (both its video and audio are skipped).
	Disabled bool `json:"disabled,omitempty"`
	// Title makes this a text clip (no asset). It is rendered to a full-canvas
	// PNG and composited like any visual, so transforms/transitions/keyframes/
	// effects/fades all apply. Duration comes from In/Out like any clip.
	Title *Title `json:"title,omitempty"`
	// Annotation makes this a callout clip (no asset) — the arrows, boxes and
	// step numbers a tutorial points with. Like Title it renders to a
	// full-canvas PNG, so transforms/keyframes/transitions/effects all apply.
	Annotation *Annotation `json:"annotation,omitempty"`
	// Redactions blur or pixelate regions of this clip's picture. Applied to the
	// clip's own pixels before any transform, so they travel with the content.
	Redactions []Redaction `json:"redactions,omitempty"`
	// Chroma removes a background colour from this clip, so whatever sits below
	// it on the timeline shows through. Applied before any scaling.
	Chroma *ChromaKey `json:"chroma,omitempty"`
	// Device wraps this clip's picture in a drawn phone/laptop/browser frame.
	Device *DeviceFrame `json:"device,omitempty"`
	// Cursor emphasises the pointer during a screen recording. It only does
	// anything when the clip's asset has a recorded pointer track beside it
	// (a .cursor.json sidecar); on any other clip it is inert.
	Cursor *CursorFX `json:"cursor,omitempty"`
}

// CursorFX turns on pointer emphasis for a screen recording. Each effect is a
// pointer so "off" and "on with defaults" stay distinguishable in the document.
type CursorFX struct {
	Highlight *CursorHighlight `json:"highlight,omitempty"`
	Clicks    *CursorClicks    `json:"clicks,omitempty"`
	Spotlight *CursorSpotlight `json:"spotlight,omitempty"`
	// Sound plays a synthesised click at each press. Independent of Clicks so a
	// recording can have the sound without the rings, or the other way round.
	Sound *CursorClickSound `json:"sound,omitempty"`
	// Pointer draws Studio's own cursor. It only applies to a recording whose
	// track says the real cursor was kept out of the capture — drawing a second
	// cursor over a burned-in one is worse than drawing none.
	Pointer *CursorPointer `json:"pointer,omitempty"`
}

// CursorPointer is the cursor Studio draws itself, which is what makes size,
// styling and smoothing possible at all.
type CursorPointer struct {
	Size    int     `json:"size,omitempty"`    // height in canvas px (0 → 44)
	Opacity float64 `json:"opacity,omitempty"` // 0..1 (0 → 1)
	Style   string  `json:"style,omitempty"`   // arrow | dot | ring (empty → arrow)
	Color   string  `json:"color,omitempty"`   // fill hex (empty → white)
	// Smoothing irons the jitter out of hand movement, 0..1. Clicks stay
	// anchored to where they actually landed: a smoothed path that drifts off
	// the button being clicked is worse than a slightly shaky one.
	Smoothing float64 `json:"smoothing,omitempty"`
}

// CursorClickSound adds an audible click at each press, mixed as one generated
// track rather than one input per click.
type CursorClickSound struct {
	Volume float64 `json:"volume,omitempty"` // 0..1 (0 → 0.35)
	Style  string  `json:"style,omitempty"`  // click | tick | soft (empty → click)
}

// CursorHighlight draws a soft disc under the pointer so it stays findable on a
// busy screen.
type CursorHighlight struct {
	Size    int     `json:"size,omitempty"`    // diameter in canvas px (0 → 96)
	Color   string  `json:"color,omitempty"`   // hex (empty → amber)
	Opacity float64 `json:"opacity,omitempty"` // 0..1 (0 → 0.35)
}

// CursorClicks draws a ring that expands and fades at each press, giving the
// viewer the feedback the recording itself can't show.
type CursorClicks struct {
	Size     int     `json:"size,omitempty"`     // final diameter in canvas px (0 → 140)
	Color    string  `json:"color,omitempty"`    // hex (empty → white)
	Duration float64 `json:"duration,omitempty"` // seconds per ring (0 → 0.45)
}

// CursorSpotlight dims everything except a radius around the pointer.
type CursorSpotlight struct {
	Radius int     `json:"radius,omitempty"` // clear radius in canvas px (0 → 220)
	Dim    float64 `json:"dim,omitempty"`    // 0..1 darkness outside it (0 → 0.55)
}

// Title is a text overlay clip.
type Title struct {
	Text       string  `json:"text"`
	Size       int     `json:"size"`                 // px at a 1080-tall reference
	Color      string  `json:"color"`                // hex, e.g. "#ffffff"
	Align      string  `json:"align,omitempty"`      // left|center|right (default center)
	PosY       float64 `json:"posY"`                 // 0..1 base vertical anchor
	Background string  `json:"background,omitempty"` // optional hex band behind the text
	Bold       bool    `json:"bold,omitempty"`
	// Anim names the entrance/exit animation preset the editor applied (fade,
	// fadeUp, pop, slide, zoom). It's a UI hint only — the actual motion lives in
	// the clip's Keyframes/Transitions, which the renderer already honors.
	Anim string `json:"anim,omitempty"`
	// Reveal turns on a per-word/character text build-on ("typewriter" | "word").
	// Unlike Anim, this can't be expressed as transform keyframes on a single
	// still, so the renderer composites a sequence of prefix PNGs (see addTitleClip).
	Reveal string `json:"reveal,omitempty"`
}

// Redaction kinds.
const (
	RedactBlur     = "blur"
	RedactPixelate = "pixelate"
)

// Redaction hides part of a clip's own picture — a password, a customer name, a
// licence key that must not ship. Unlike an Annotation it is not drawn on top of
// the frame: it resamples the frame's own pixels, so there is nothing to peel
// off the finished video.
type Redaction struct {
	Kind string `json:"kind"` // blur|pixelate

	// Fractions of THE CLIP'S OWN FRAME (0..1), not of the canvas. That is what
	// makes a redaction stick to the thing it hides: the region is applied before
	// the clip is scaled or panned, so a zoom carries the blur along with the
	// content instead of sliding it off.
	X float64 `json:"x"`
	Y float64 `json:"y"`
	W float64 `json:"w"`
	H float64 `json:"h"`

	// Amount is 0..1 strength (0 = unset → a sensible default).
	Amount float64 `json:"amount,omitempty"`
}

// Device frame kinds.
const (
	DeviceBrowser = "browser"
	DevicePhone   = "phone"
	DeviceTablet  = "tablet"
	DeviceLaptop  = "laptop"
)

// DeviceFrame puts a clip's picture inside a drawn device — a phone, a laptop,
// a browser window. The frame is composited at canvas size BEFORE the clip's
// own transform, so the device and the picture inside it move, scale and
// keyframe as one object rather than sliding apart.
type DeviceFrame struct {
	Kind string `json:"kind"` // browser|phone|tablet|laptop

	// Color is the body colour as a hex triple; empty is a near-black.
	Color string `json:"color,omitempty"`
}

// ChromaKey removes a background colour so the clip below shows through — the
// green screen behind a talking head. Applied to the clip's own pixels before
// any scaling, because keying interpolated pixels cannot separate a real edge
// from a blended one.
type ChromaKey struct {
	// Color is the screen's colour as a hex triple. Empty means the standard
	// chroma green, which is what a bought screen actually is.
	Color string `json:"color,omitempty"`

	// Similarity is how far from Color still counts as background, 0..1.
	// Too low leaves a fringe; too high starts eating the subject.
	Similarity float64 `json:"similarity,omitempty"`

	// Blend softens the edge between kept and keyed, 0..1. A hard cut looks
	// cut out; a little blend is what makes the composite believable.
	Blend float64 `json:"blend,omitempty"`

	// Spill neutralises the screen's light bouncing onto the subject, 0..1.
	// Independent of the key: a well-keyed shot can still have green ears.
	Spill float64 `json:"spill,omitempty"`
}

// Annotation kinds. Anything not recognised draws nothing rather than
// guessing — a callout in the wrong shape is worse than a missing one.
const (
	AnnoArrow     = "arrow"
	AnnoBox       = "box"
	AnnoEllipse   = "ellipse"
	AnnoHighlight = "highlight"
	AnnoNumber    = "number"
	AnnoText      = "text"
	AnnoKeys      = "keys"
)

// Annotation is a shape drawn over the video — the callouts a tutorial points
// with. It is deliberately one struct with a Kind rather than a union: every
// shape is a stroke, a fill and (sometimes) a label over the same box, and the
// editor is far simpler when switching kind keeps the geometry you placed.
type Annotation struct {
	Kind string `json:"kind"` // arrow|box|ellipse|highlight|number|text

	// Geometry in canvas fractions (0..1), NOT pixels, so a callout keeps its
	// place when the project is exported at another size. For an arrow (X,Y) is
	// the tail and (X2,Y2) the point; for every other kind they are the top-left
	// and size of the bounding box.
	X  float64 `json:"x"`
	Y  float64 `json:"y"`
	W  float64 `json:"w,omitempty"`
	H  float64 `json:"h,omitempty"`
	X2 float64 `json:"x2,omitempty"`
	Y2 float64 `json:"y2,omitempty"`

	Color     string  `json:"color,omitempty"`     // stroke/shape colour (default amber)
	Fill      string  `json:"fill,omitempty"`      // interior; "" = hollow
	Thickness float64 `json:"thickness,omitempty"` // px at a 1080-tall reference
	Opacity   float64 `json:"opacity,omitempty"`   // 0..1 (0 = unset → 1)
	Radius    float64 `json:"radius,omitempty"`    // corner rounding, px at 1080 reference

	// Text labels the shape: the digits for a "number" badge, the message for a
	// "text" callout, an optional caption on any other kind.
	Text      string `json:"text,omitempty"`
	TextSize  int    `json:"textSize,omitempty"`  // px at a 1080-tall reference
	TextColor string `json:"textColor,omitempty"` // default white
}

// Effects are per-clip color/blur adjustments (compiled to ffmpeg eq/hue/gblur).
// Identity values (brightness 0, contrast 1, saturation 1, hue 0, blur 0) are no-ops.
type Effects struct {
	Brightness float64 `json:"brightness,omitempty"` // -1..1 (0 = none)
	Contrast   float64 `json:"contrast,omitempty"`   // 0..2 (1 = none)
	Saturation float64 `json:"saturation,omitempty"` // 0..3 (1 = none)
	Hue        float64 `json:"hue,omitempty"`        // degrees (0 = none)
	Blur       float64 `json:"blur,omitempty"`       // gaussian sigma px (0 = none)
}

// AudioEQ is a simple 3-band equalizer applied to a clip's audio. Gains are in
// decibels, roughly -12..+12 (0 = flat). Compiled to ffmpeg bass/equalizer/treble.
type AudioEQ struct {
	Low  float64 `json:"low,omitempty"`  // low-shelf gain, dB (≈100 Hz)
	Mid  float64 `json:"mid,omitempty"`  // mid peak gain, dB (≈1 kHz)
	High float64 `json:"high,omitempty"` // high-shelf gain, dB (≈8 kHz)
}

// Keyframe is one animation control point: Value at clip-local time T (seconds).
// Ease names the interpolation curve for the segment FROM this keyframe to the
// next one ("" = linear); one of linear|easeInOut|easeInCubic|easeOutCubic|
// easeOutBack|easeOutElastic|springOut (see render.easeProgress).
type Keyframe struct {
	T     float64 `json:"t"`
	Value float64 `json:"value"`
	Ease  string  `json:"ease,omitempty"`
}

// Transition is an entrance/exit effect on a clip.
//
//	fade|dissolve            — alpha fade to/from the background (dissolve reads as
//	                           a crossfade when a neighbouring clip overlaps in time)
//	slide-left|right|top|bottom — the clip slides in from / out toward that edge
type Transition struct {
	Type     string  `json:"type"`
	Duration float64 `json:"duration"` // seconds (<=0 → 0.5s default at render)
}

// PlayDur is the on-timeline duration of the clip after speed scaling.
func (c Clip) PlayDur() float64 {
	sp := c.Speed
	if sp <= 0 {
		sp = 1
	}
	d := (c.Out - c.In) / sp
	if d < 0 {
		d = 0
	}
	if c.Hold > 0 {
		d += c.Hold
	}
	return d
}

// CaptionStyle controls how a cue is drawn/burned in.
type CaptionStyle struct {
	Font  string  `json:"font"`
	Size  int     `json:"size"`
	Color string  `json:"color"`
	Align string  `json:"align"` // left|center|right
	PosY  float64 `json:"posY"`  // 0..1 vertical position
}

// CaptionCue is a timed line of transcript text.
type CaptionCue struct {
	ID    string       `json:"id"`
	Start float64      `json:"start"`
	End   float64      `json:"end"`
	Text  string       `json:"text"`
	Style CaptionStyle `json:"style"`
}

// Track kinds.
const (
	TrackBackground = "background"
	TrackVideo      = "video"
	TrackOverlay    = "overlay"
	TrackAudio      = "audio"
	TrackCaption    = "caption"
)

// Track is one horizontal lane. Video/overlay/audio tracks hold Clips; caption
// tracks hold Cues; background tracks hold either a full-frame Clip or a color.
type Track struct {
	ID              string       `json:"id"`
	Kind            string       `json:"kind"`
	Name            string       `json:"name,omitempty"`
	Clips           []Clip       `json:"clips,omitempty"`
	Cues            []CaptionCue `json:"cues,omitempty"`
	BackgroundColor string       `json:"backgroundColor,omitempty"`
	Muted           bool         `json:"muted,omitempty"`
	Hidden          bool         `json:"hidden,omitempty"`
	Solo            bool         `json:"solo,omitempty"`
	// Duck marks an audio track as a music/bed lane: its level is automatically
	// compressed (sidechained) under the voice — every non-ducked audio source.
	Duck bool `json:"duck,omitempty"`
}

// Asset is an imported or generated media file registered to a project.
type Asset struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Kind      string  `json:"kind"` // video|audio|image
	Path      string  `json:"path"` // relative to the media root
	Duration  float64 `json:"duration"`
	Width     int     `json:"width"`
	Height    int     `json:"height"`
	HasAlpha  bool    `json:"hasAlpha"`
	HasAudio  *bool   `json:"hasAudio,omitempty"`  // nil = not yet probed; false = silent (no audio stream)
	Thumbnail string  `json:"thumbnail,omitempty"` // relative to the media root
	Source    string  `json:"source"`              // import|newaniadv|hyperframes
	CreatedAt string  `json:"createdAt"`
	// Generation provenance: kept so a generated asset stays "live" and can be
	// re-rendered from the studio. GenInput is the generator input (e.g. the
	// FunkyCode scenes JSON); GenParams are the CLI flag values. Empty for
	// imported assets. Source doubles as the generator id for generated assets.
	GenInput  string            `json:"genInput,omitempty"`
	GenParams map[string]string `json:"genParams,omitempty"`
	// HasCursor marks a screen recording that arrived with a pointer track
	// beside it. The editor keys the cursor-effects panel off this: offering the
	// controls on a clip that can never show them is worse than not offering them.
	HasCursor bool `json:"hasCursor,omitempty"`
	// CursorHidden means the OS cursor was kept out of the capture, so Studio
	// owns drawing it. Only then can the cursor be resized, restyled or
	// smoothed — otherwise it is part of the pixels.
	CursorHidden bool `json:"cursorHidden,omitempty"`
}

// EditDoc is the whole persisted project state.
type EditDoc struct {
	ID      string   `json:"id"`
	Name    string   `json:"name"`
	Version int      `json:"version"`
	Canvas  Canvas   `json:"canvas"`
	Tracks  []Track  `json:"tracks"`
	Assets  []Asset  `json:"assets"`
	Markers []Marker `json:"markers,omitempty"`
	Updated string   `json:"updated,omitempty"`
}

// Marker is a timeline annotation (editor aid; not composited into the export).
type Marker struct {
	ID    string  `json:"id"`
	T     float64 `json:"t"` // seconds
	Label string  `json:"label,omitempty"`
	Color string  `json:"color,omitempty"`
}

// DefaultTracks returns the standard lane layout for a new project.
func DefaultTracks() []Track {
	return []Track{
		{ID: "t_bg", Kind: TrackBackground, Name: "Background", BackgroundColor: "#000000"},
		{ID: "t_video", Kind: TrackVideo, Name: "Video"},
		{ID: "t_overlay", Kind: TrackOverlay, Name: "Overlay"},
		{ID: "t_music", Kind: TrackAudio, Name: "Music"},
		{ID: "t_caption", Kind: TrackCaption, Name: "Captions"},
	}
}
