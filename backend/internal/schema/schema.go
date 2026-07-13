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
	X       float64 `json:"x"`
	Y       float64 `json:"y"`
	Scale   float64 `json:"scale"`
	Opacity float64 `json:"opacity"`
}

// Clip is a placed reference to an asset on a track.
type Clip struct {
	ID            string    `json:"id"`
	AssetID       string    `json:"assetId"`
	Start         float64   `json:"start"` // position on the timeline (seconds)
	In            float64   `json:"in"`    // trim start within the source (seconds)
	Out           float64   `json:"out"`   // trim end within the source (seconds)
	Transform     Transform `json:"transform"`
	Volume        float64   `json:"volume"` // 0..1, audio gain for this clip
	Speed         float64   `json:"speed,omitempty"`   // playback rate (1 = normal); 0 treated as 1
	FadeIn        float64     `json:"fadeIn,omitempty"`  // seconds of fade-in
	FadeOut       float64     `json:"fadeOut,omitempty"` // seconds of fade-out
	TransitionIn  *Transition `json:"transitionIn,omitempty"`
	TransitionOut *Transition `json:"transitionOut,omitempty"`
	// Keyframes animate a property over the clip's life. Keyed by property name:
	// "x"/"y" (position offset in canvas px), "scale" (multiplier, 1 = canvas-fit),
	// "opacity" (0..1). Points are clip-local seconds (from Start) so they survive
	// moving/splitting the clip.
	Keyframes map[string][]Keyframe `json:"keyframes,omitempty"`
	Effects   *Effects              `json:"effects,omitempty"`
	// EQ is an optional 3-band equalizer on this clip's audio.
	EQ *AudioEQ `json:"eq,omitempty"`
	// LUT names a .cube color lookup table (in the project's luts dir) applied to
	// this clip's video. Empty = none.
	LUT string `json:"lut,omitempty"`
	// Title makes this a text clip (no asset). It is rendered to a full-canvas
	// PNG and composited like any visual, so transforms/transitions/keyframes/
	// effects/fades all apply. Duration comes from In/Out like any clip.
	Title *Title `json:"title,omitempty"`
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
		return 0
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
	Thumbnail string  `json:"thumbnail,omitempty"` // relative to the media root
	Source    string  `json:"source"`              // import|newaniadv|hyperframes
	CreatedAt string  `json:"createdAt"`
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
