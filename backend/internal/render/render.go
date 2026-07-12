// Package render compiles an edit document into an FFmpeg invocation and runs
// it. This is the authoritative export path: the same timeline the browser
// previews approximately is turned into a deterministic filtergraph here.
package render

import (
	"bufio"
	"context"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"studio/internal/jobs"
	"studio/internal/schema"
)

// AssetResolver maps an asset id to an absolute file path on disk.
type AssetResolver func(assetID string) (string, bool)

// Options tune a single export (preset geometry, container format, range).
type Options struct {
	Preset string  `json:"preset"` // "" (source) | shorts | square | 4k | portrait4k
	Format string  `json:"format"` // "" (mp4) | mp4 | webm | gif | mov
	From    float64 `json:"from"`    // range start seconds
	To      float64 `json:"to"`      // range end seconds (0 = end)
	FPS     int     `json:"fps"`     // override output fps (0 = doc fps)
	FrameAt float64 `json:"frameAt"` // >0: render a single PNG frame at this time
}

// visual is a resolved visual clip ready for the filtergraph.
type visual struct {
	path              string
	in, out           float64
	start, end        float64
	x, y              int
	sw, sh            int
	opacity           float64
	speed             float64
	fadeIn, fadeOut   float64
	transIn, transOut *schema.Transition
	cx, cy            int                          // centered base position (no offset) for keyframes
	keyframes         map[string][]schema.Keyframe // property -> control points (clip-local t)
	effects           *schema.Effects
	still             bool // input is a looped still image (title), not a trimmed video
}

// audio is a resolved audio contribution.
type audio struct {
	path            string
	in, out         float64
	start           float64
	volume          float64
	speed           float64
	fadeIn, fadeOut float64
}

// Plan is the compiled ffmpeg command plus side artifacts (srt path).
type Plan struct {
	Args    []string
	SRTPath string
	Dur     float64
}

// presetDims returns output geometry for a preset (falls back to doc canvas).
func presetDims(preset string, w, h int) (int, int) {
	switch preset {
	case "shorts", "vertical", "portrait":
		return 1080, 1920
	case "square":
		return 1080, 1080
	case "4k", "landscape4k":
		return 3840, 2160
	case "portrait4k":
		return 2160, 3840
	default:
		return w, h
	}
}

// Compile turns an edit document into an ffmpeg arg vector writing to outPath.
func Compile(doc *schema.EditDoc, resolve AssetResolver, outPath, srtDir string, opts Options) (*Plan, error) {
	w, h, fps := doc.Canvas.Width, doc.Canvas.Height, doc.Canvas.FPS
	if w == 0 || h == 0 {
		w, h = 1920, 1080
	}
	if fps == 0 {
		fps = 30
	}
	if opts.FPS > 0 {
		fps = opts.FPS
	}

	// Collect visual clips bottom->top: background, video, overlay.
	var visuals []visual
	var audios []audio
	var cues []schema.CaptionCue
	bgColor := "#000000"

	order := map[string]int{schema.TrackBackground: 0, schema.TrackVideo: 1, schema.TrackOverlay: 2}
	tracks := append([]schema.Track(nil), doc.Tracks...)
	sort.SliceStable(tracks, func(i, j int) bool {
		return order[tracks[i].Kind] < order[tracks[j].Kind]
	})

	// Solo: if any content track is soloed, non-soloed content tracks are
	// suppressed. The background base is never solo-suppressed.
	soloActive := false
	for _, t := range doc.Tracks {
		if t.Solo {
			soloActive = true
			break
		}
	}
	titleIdx := 0

	for _, t := range tracks {
		suppressed := soloActive && !t.Solo && t.Kind != schema.TrackBackground
		if t.Hidden || suppressed {
			continue
		}
		switch t.Kind {
		case schema.TrackBackground:
			if t.BackgroundColor != "" {
				bgColor = t.BackgroundColor
			}
			for _, c := range t.Clips {
				addClip(&visuals, &audios, c, resolve, w, h, true, t.Muted)
			}
		case schema.TrackVideo, schema.TrackOverlay:
			for _, c := range t.Clips {
				if c.Title != nil {
					if err := addTitleClip(&visuals, c, w, h, srtDir, titleIdx); err == nil {
						titleIdx++
					}
					continue
				}
				addClip(&visuals, &audios, c, resolve, w, h, false, t.Muted)
			}
		case schema.TrackAudio:
			if t.Muted {
				continue
			}
			for _, c := range t.Clips {
				p, ok := resolve(c.AssetID)
				if !ok {
					continue
				}
				vol := c.Volume
				if vol == 0 {
					vol = 1
				}
				audios = append(audios, audio{
					path: p, in: c.In, out: c.Out, start: c.Start, volume: vol,
					speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut,
				})
			}
		case schema.TrackCaption:
			cues = append(cues, t.Cues...)
		}
	}

	// Drop audio contributions whose source has no audio stream (e.g. silent
	// template clips) — referencing [N:a] on such an input aborts the whole render.
	if len(audios) > 0 {
		audible := map[string]bool{}
		hasAud := func(p string) bool {
			if v, ok := audible[p]; ok {
				return v
			}
			out, _ := exec.Command("ffprobe", "-v", "error", "-select_streams", "a",
				"-show_entries", "stream=index", "-of", "csv=p=0", p).Output()
			v := len(strings.TrimSpace(string(out))) > 0
			audible[p] = v
			return v
		}
		kept := audios[:0]
		for _, a := range audios {
			if hasAud(a.path) {
				kept = append(kept, a)
			}
		}
		audios = kept
	}

	// Total duration = furthest clip/cue end.
	dur := 0.0
	for _, v := range visuals {
		dur = math.Max(dur, v.end)
	}
	for _, a := range audios {
		dur = math.Max(dur, a.start+playSpan(a.in, a.out, a.speed))
	}
	for _, c := range cues {
		dur = math.Max(dur, c.End)
	}
	if dur <= 0 {
		dur = 1
	}

	gif := opts.Format == "gif"
	if gif && (opts.FPS == 0) {
		fps = minInt(fps, 20) // keep gifs sane
	}

	args := []string{"-y", "-loglevel", "error", "-progress", "pipe:1", "-stats_period", "0.2"}

	// Input 0: background color canvas.
	args = append(args, "-f", "lavfi", "-i",
		fmt.Sprintf("color=c=%s:s=%dx%d:r=%d:d=%.3f", ffColor(bgColor), w, h, fps, dur))

	var fc strings.Builder
	base := "[0:v]"
	inputIdx := 1

	// Visual clips: trim, speed, position, opacity, fades/transitions, then overlay.
	for i, v := range visuals {
		lbl := fmt.Sprintf("[v%d]", i)
		sp := v.speed
		if sp <= 0 {
			sp = 1
		}
		tr := resolveTransitions(v)
		if v.still {
			// Looped still (title PNG): bound to its span, PTS shifted to start.
			args = append(args, "-loop", "1", "-t", fmt.Sprintf("%.3f", v.end-v.start), "-i", v.path)
			fmt.Fprintf(&fc,
				"[%d:v]setpts=PTS-STARTPTS+%.3f/TB,scale=%d:%d:flags=bicubic,format=rgba",
				inputIdx, v.start, v.sw, v.sh)
		} else {
			args = append(args, "-i", v.path)
			fmt.Fprintf(&fc,
				"[%d:v]trim=start=%.3f:end=%.3f,setpts=(PTS-STARTPTS)/%.4f+%.3f/TB,scale=%d:%d:flags=bicubic,format=rgba",
				inputIdx, v.in, v.out, sp, v.start, v.sw, v.sh)
		}
		// Opacity: animated alpha via geq when keyframed, else a constant multiplier.
		if okf := v.keyframes["opacity"]; len(okf) > 0 {
			fmt.Fprintf(&fc,
				",geq=r='p(X,Y)':g='p(X,Y)':b='p(X,Y)':a='p(X,Y)*clip(%s,0,1)'",
				kfOpacityExpr(v.start, okf))
		} else {
			fmt.Fprintf(&fc, ",colorchannelmixer=aa=%.3f", v.opacity)
		}
		// Per-clip color/blur effects.
		fc.WriteString(effectFilters(v.effects))
		// Alpha fade in/out — driven by fade/dissolve transitions or explicit fades.
		if tr.alphaIn > 0 {
			fmt.Fprintf(&fc, ",fade=t=in:st=%.3f:d=%.3f:alpha=1", v.start, tr.alphaIn)
		}
		if tr.alphaOut > 0 {
			fmt.Fprintf(&fc, ",fade=t=out:st=%.3f:d=%.3f:alpha=1", math.Max(v.start, v.end-tr.alphaOut), tr.alphaOut)
		}
		fmt.Fprintf(&fc, "%s;", lbl)
		out := fmt.Sprintf("[b%d]", i)
		// Position — keyframes (motion) win per axis, else a slide expression, else static.
		xPos := axisPos(v.x, v.start, v.end, tr.xInOff, tr.xInDur, tr.xOutOff, tr.xOutDur)
		yPos := axisPos(v.y, v.start, v.end, tr.yInOff, tr.yInDur, tr.yOutOff, tr.yOutDur)
		if kf := v.keyframes["x"]; len(kf) > 0 {
			xPos = kfExpr(v.cx, v.start, kf)
		}
		if kf := v.keyframes["y"]; len(kf) > 0 {
			yPos = kfExpr(v.cy, v.start, kf)
		}
		fmt.Fprintf(&fc,
			"%s%soverlay=x=%s:y=%s:enable='between(t,%.3f,%.3f)':eof_action=pass:format=auto%s;",
			base, lbl, xPos, yPos, v.start, v.end, out)
		base = out
		inputIdx++
	}

	// Caption burn-in: render each cue to a full-canvas transparent PNG and
	// overlay it (works on any ffmpeg build; minimal ones lack subtitles/drawtext).
	if len(cues) > 0 {
		_ = writeSRT(filepath.Join(srtDir, "captions.srt"), cues)
		for i, c := range cues {
			if c.End <= c.Start || strings.TrimSpace(c.Text) == "" {
				continue
			}
			png := filepath.Join(srtDir, fmt.Sprintf("cap-%d.png", i))
			if err := renderCaptionPNG(c, w, h, png); err != nil {
				continue
			}
			// Bound the looped still with -t so every input reaches EOF; an unbounded
			// -loop hangs filters that need end-of-stream (e.g. gif palettegen).
			args = append(args, "-loop", "1", "-t", fmt.Sprintf("%.3f", dur), "-i", png)
			out := fmt.Sprintf("[c%d]", i)
			fmt.Fprintf(&fc, "%s[%d:v]overlay=x=0:y=0:enable='between(t,%.3f,%.3f)':eof_action=repeat:format=auto%s;",
				base, inputIdx, c.Start, c.End, out)
			base = out
			inputIdx++
		}
	}

	// Audio graph: trim, speed (atempo), volume, fades, delay, then mix.
	audioLabels := []string{}
	if !gif {
		for i, a := range audios {
			args = append(args, "-i", a.path)
			lbl := fmt.Sprintf("[a%d]", i)
			ms := int(a.start * 1000)
			span := playSpan(a.in, a.out, a.speed)
			fmt.Fprintf(&fc, "[%d:a]atrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS", inputIdx, a.in, a.out)
			for _, t := range atempoChain(a.speed) {
				fmt.Fprintf(&fc, ",atempo=%.4f", t)
			}
			fmt.Fprintf(&fc, ",volume=%.3f", a.volume)
			if a.fadeIn > 0 {
				fmt.Fprintf(&fc, ",afade=t=in:st=0:d=%.3f", a.fadeIn)
			}
			if a.fadeOut > 0 {
				fmt.Fprintf(&fc, ",afade=t=out:st=%.3f:d=%.3f", math.Max(0, span-a.fadeOut), a.fadeOut)
			}
			fmt.Fprintf(&fc, ",adelay=%d|%d%s;", ms, ms, lbl)
			audioLabels = append(audioLabels, lbl)
			inputIdx++
		}
	}
	haveAudio := len(audioLabels) > 0
	if haveAudio {
		fmt.Fprintf(&fc, "%samix=inputs=%d:normalize=0:dropout_transition=0[amix];",
			strings.Join(audioLabels, ""), len(audioLabels))
	}

	// ---- finalize: range trim, preset scale/pad, gif palette ----
	outW, outH := presetDims(opts.Preset, w, h)
	rangeActive := opts.From > 0 || (opts.To > 0 && opts.To < dur)
	presetActive := outW != w || outH != h
	vlab := base // current video label
	alab := "[amix]"

	// Only produce a graph video label if we have clips/captions or need finalize.
	hasVideoGraph := len(visuals) > 0 || strings.Contains(fc.String(), "[c") || rangeActive || presetActive || gif
	if vlab == "[0:v]" && hasVideoGraph {
		// route the bare bg through a passthrough so we can attach finalize filters
		fmt.Fprintf(&fc, "[0:v]null[vpass];")
		vlab = "[vpass]"
	}

	if rangeActive {
		fmt.Fprintf(&fc, "%strim=start=%.3f:end=%.3f,setpts=PTS-STARTPTS[vr];", vlab, opts.From, rangeEnd(opts.To, dur))
		vlab = "[vr]"
		if haveAudio {
			fmt.Fprintf(&fc, "%satrim=start=%.3f:end=%.3f,asetpts=PTS-STARTPTS[ar];", alab, opts.From, rangeEnd(opts.To, dur))
			alab = "[ar]"
		}
	}
	if presetActive {
		fmt.Fprintf(&fc,
			"%sscale=%d:%d:force_original_aspect_ratio=decrease,pad=%d:%d:(ow-iw)/2:(oh-ih)/2:color=%s,setsar=1[vp];",
			vlab, outW, outH, outW, outH, ffColor(bgColor))
		vlab = "[vp]"
	}
	if gif {
		fmt.Fprintf(&fc, "%ssplit[gs0][gs1];[gs0]palettegen=stats_mode=diff[gp];[gs1][gp]paletteuse=dither=bayer[vg];", vlab)
		vlab = "[vg]"
	}

	filter := strings.TrimSuffix(fc.String(), ";")
	if filter != "" {
		args = append(args, "-filter_complex", filter)
	}

	// map video
	if filter == "" {
		args = append(args, "-map", "0:v")
	} else {
		args = append(args, "-map", vlab)
	}

	// Single-frame mode: seek the composited stream and write one PNG (no audio).
	if opts.FrameAt > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", opts.FrameAt), "-frames:v", "1", "-update", "1", outPath)
		return &Plan{Args: args, Dur: 0}, nil
	}

	// map audio + codec
	if haveAudio && !gif {
		args = append(args, "-map", alab)
	}

	outDur := dur
	if rangeActive {
		outDur = rangeEnd(opts.To, dur) - opts.From
	}

	args = append(args, codecArgs(opts.Format, haveAudio && !gif)...)
	args = append(args, "-t", fmt.Sprintf("%.3f", outDur), "-r", fmt.Sprintf("%d", fps), outPath)

	return &Plan{Args: args, SRTPath: filepath.Join(srtDir, "captions.srt"), Dur: outDur}, nil
}

// codecArgs returns encoder flags for the requested container format.
func codecArgs(format string, withAudio bool) []string {
	var a []string
	switch format {
	case "webm":
		a = []string{"-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "32", "-pix_fmt", "yuv420p", "-row-mt", "1"}
		if withAudio {
			a = append(a, "-c:a", "libopus", "-b:a", "128k")
		}
	case "gif":
		a = []string{} // palette handled in graph; no audio for gif
	case "mov":
		a = []string{"-c:v", "prores_ks", "-profile:v", "3", "-pix_fmt", "yuv422p10le"}
		if withAudio {
			a = append(a, "-c:a", "aac", "-b:a", "192k")
		}
	default: // mp4 / h264
		a = []string{"-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18", "-movflags", "+faststart"}
		if withAudio {
			a = append(a, "-c:a", "aac", "-b:a", "192k")
		}
	}
	return a
}

func addClip(visuals *[]visual, audios *[]audio, c schema.Clip, resolve AssetResolver, w, h int, isBG, muted bool) {
	p, ok := resolve(c.AssetID)
	if !ok {
		return
	}
	span := playSpan(c.In, c.Out, c.Speed)
	if span <= 0 {
		return
	}
	scale := c.Transform.Scale
	if scale == 0 {
		scale = 1
	}
	op := c.Transform.Opacity
	if op == 0 {
		op = 1
	}
	sw := int(float64(w) * scale)
	sh := int(float64(h) * scale)
	if sw < 2 {
		sw = 2
	}
	if sh < 2 {
		sh = 2
	}
	cx, cy := (w-sw)/2, (h-sh)/2
	x := cx + int(c.Transform.X)
	y := cy + int(c.Transform.Y)
	if isBG {
		sw, sh, x, y, cx, cy = w, h, 0, 0, 0, 0
	}
	*visuals = append(*visuals, visual{
		path: p, in: c.In, out: c.Out, start: c.Start, end: c.Start + span,
		x: x, y: y, sw: sw, sh: sh, opacity: op,
		speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut,
		transIn: c.TransitionIn, transOut: c.TransitionOut,
		cx: cx, cy: cy, keyframes: c.Keyframes, effects: c.Effects,
	})
	if !muted && !isBG {
		vol := c.Volume
		if vol == 0 {
			vol = 1
		}
		*audios = append(*audios, audio{
			path: p, in: c.In, out: c.Out, start: c.Start, volume: vol,
			speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut,
		})
	}
}

const defTransDur = 0.5 // fallback transition duration when unset

// transPlan is a clip's transitions resolved into concrete filtergraph inputs:
// alpha-fade durations (fade/dissolve) and per-axis slide offsets/durations.
type transPlan struct {
	alphaIn, alphaOut float64
	xInOff, xOutOff   string // "" = none; else an ffmpeg overlay-x expression edge (-w / W)
	xInDur, xOutDur   float64
	yInOff, yOutOff   string // edge (-h / H)
	yInDur, yOutDur   float64
}

// resolveTransitions folds explicit fades and named transitions into a transPlan.
func resolveTransitions(v visual) transPlan {
	tp := transPlan{alphaIn: v.fadeIn, alphaOut: v.fadeOut}
	apply := func(t *schema.Transition, in bool) {
		if t == nil || t.Type == "" {
			return
		}
		d := t.Duration
		if d <= 0 {
			d = defTransDur
		}
		setX := func(off string) {
			if in {
				tp.xInOff, tp.xInDur = off, d
			} else {
				tp.xOutOff, tp.xOutDur = off, d
			}
		}
		setY := func(off string) {
			if in {
				tp.yInOff, tp.yInDur = off, d
			} else {
				tp.yOutOff, tp.yOutDur = off, d
			}
		}
		switch t.Type {
		case "fade", "dissolve":
			if in {
				tp.alphaIn = math.Max(tp.alphaIn, d)
			} else {
				tp.alphaOut = math.Max(tp.alphaOut, d)
			}
		case "slide-left":
			setX("-w")
		case "slide-right":
			setX("W")
		case "slide-top":
			setY("-h")
		case "slide-bottom":
			setY("H")
		}
	}
	apply(v.transIn, true)
	apply(v.transOut, false)
	return tp
}

// axisPos returns an overlay coordinate: a plain integer, or a single-quoted
// ffmpeg expression that ramps from/to an off-screen edge for a slide. inOff/
// outOff are edge expressions (e.g. "-w", "W"); "" means no slide on this axis.
func axisPos(target int, S, E float64, inOff string, inDur float64, outOff string, outDur float64) string {
	if inOff == "" && outOff == "" {
		return fmt.Sprintf("%d", target)
	}
	expr := fmt.Sprintf("%d", target)
	if outOff != "" && outDur > 0 { // exit: target -> edge over [E-dur, E]
		st := E - outDur
		ramp := fmt.Sprintf("(%d+((%s)-(%d))*(t-%.3f)/%.3f)", target, outOff, target, st, outDur)
		expr = fmt.Sprintf("if(gte(t,%.3f),%s,%s)", st, ramp, expr)
	}
	if inOff != "" && inDur > 0 { // entrance: edge -> target over [S, S+dur]
		ramp := fmt.Sprintf("((%s)+(%d-(%s))*(t-%.3f)/%.3f)", inOff, target, inOff, S, inDur)
		expr = fmt.Sprintf("if(lt(t,%.3f),%s,%s)", S+inDur, ramp, expr)
	}
	return "'" + expr + "'"
}

// effectFilters emits the eq/hue/gblur chain for a clip's effects (empty when
// nil or all-identity). Leading comma so it appends to the clip's filter string.
func effectFilters(e *schema.Effects) string {
	if e == nil {
		return ""
	}
	var b strings.Builder
	eqOn := e.Brightness != 0 || (e.Contrast != 0 && e.Contrast != 1) || (e.Saturation != 0 && e.Saturation != 1)
	if eqOn {
		c := e.Contrast
		if c == 0 {
			c = 1
		}
		s := e.Saturation
		if s == 0 {
			s = 1
		}
		fmt.Fprintf(&b, ",eq=brightness=%.3f:contrast=%.3f:saturation=%.3f", e.Brightness, c, s)
	}
	if e.Hue != 0 {
		fmt.Fprintf(&b, ",hue=h=%.2f", e.Hue)
	}
	if e.Blur > 0 {
		fmt.Fprintf(&b, ",gblur=sigma=%.2f", e.Blur)
	}
	return b.String()
}

// kfExpr compiles animation keyframes into an overlay coordinate: base position
// plus a piecewise-linear function of clip-local time (t-S), holding the first/
// last value outside the keyed range. Values are canvas-px offsets from center.
func kfExpr(base int, S float64, kfs []schema.Keyframe) string {
	pts := append([]schema.Keyframe(nil), kfs...)
	sort.SliceStable(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	if len(pts) == 1 {
		return fmt.Sprintf("%d", base+int(math.Round(pts[0].Value)))
	}
	local := fmt.Sprintf("(t-%.3f)", S)
	// Innermost fallback: hold the last value.
	expr := fmt.Sprintf("%.3f", pts[len(pts)-1].Value)
	for i := len(pts) - 2; i >= 0; i-- {
		a, b := pts[i], pts[i+1]
		dt := b.T - a.T
		if dt < 1e-3 {
			dt = 1e-3
		}
		seg := fmt.Sprintf("(%.3f+(%.3f)*(%s-%.3f)/%.3f)", a.Value, b.Value-a.Value, local, a.T, dt)
		expr = fmt.Sprintf("if(lt(%s,%.3f),%s,%s)", local, b.T, seg, expr)
	}
	// Before the first key: hold the first value.
	expr = fmt.Sprintf("if(lt(%s,%.3f),%.3f,%s)", local, pts[0].T, pts[0].Value, expr)
	return fmt.Sprintf("'(%d+%s)'", base, expr)
}

// addTitleClip renders a text clip to a PNG and appends it as a still visual so
// it flows through the same transform/transition/keyframe/effect/fade pipeline.
func addTitleClip(visuals *[]visual, c schema.Clip, w, h int, srtDir string, idx int) error {
	span := c.Out - c.In
	if span <= 0 {
		span = 3
	}
	png := filepath.Join(srtDir, fmt.Sprintf("title-%d.png", idx))
	if err := renderTitlePNG(*c.Title, w, h, png); err != nil {
		return err
	}
	scale := c.Transform.Scale
	if scale == 0 {
		scale = 1
	}
	op := c.Transform.Opacity
	if op == 0 {
		op = 1
	}
	sw, sh := int(float64(w)*scale), int(float64(h)*scale)
	cx, cy := (w-sw)/2, (h-sh)/2
	*visuals = append(*visuals, visual{
		path: png, start: c.Start, end: c.Start + span,
		x: cx + int(c.Transform.X), y: cy + int(c.Transform.Y), sw: sw, sh: sh, opacity: op,
		fadeIn: c.FadeIn, fadeOut: c.FadeOut,
		transIn: c.TransitionIn, transOut: c.TransitionOut,
		cx: cx, cy: cy, keyframes: c.Keyframes, effects: c.Effects,
		still: true,
	})
	return nil
}

// kfOpacityExpr builds a bare piecewise-linear 0..1 expression of geq time T
// (clip-local via T-S), for animating a clip's alpha. Held outside the range.
func kfOpacityExpr(S float64, kfs []schema.Keyframe) string {
	pts := append([]schema.Keyframe(nil), kfs...)
	sort.SliceStable(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	if len(pts) == 1 {
		return fmt.Sprintf("%.4f", pts[0].Value)
	}
	local := fmt.Sprintf("(T-%.3f)", S)
	expr := fmt.Sprintf("%.4f", pts[len(pts)-1].Value)
	for i := len(pts) - 2; i >= 0; i-- {
		a, b := pts[i], pts[i+1]
		dt := b.T - a.T
		if dt < 1e-3 {
			dt = 1e-3
		}
		seg := fmt.Sprintf("(%.4f+(%.4f)*(%s-%.3f)/%.3f)", a.Value, b.Value-a.Value, local, a.T, dt)
		expr = fmt.Sprintf("if(lt(%s,%.3f),%s,%s)", local, b.T, seg, expr)
	}
	return fmt.Sprintf("if(lt(%s,%.3f),%.4f,%s)", local, pts[0].T, pts[0].Value, expr)
}

// playSpan is the on-timeline duration of a source range after speed scaling.
func playSpan(in, out, speed float64) float64 {
	if speed <= 0 {
		speed = 1
	}
	d := (out - in) / speed
	if d < 0 {
		return 0
	}
	return d
}

// atempoChain expresses a playback-rate change as atempo filters (each 0.5–2.0).
func atempoChain(speed float64) []float64 {
	if speed <= 0 || speed == 1 {
		return nil
	}
	var chain []float64
	s := speed
	for s > 2.0 {
		chain = append(chain, 2.0)
		s /= 2.0
	}
	for s < 0.5 {
		chain = append(chain, 0.5)
		s /= 0.5
	}
	chain = append(chain, s)
	return chain
}

func rangeEnd(to, dur float64) float64 {
	if to <= 0 || to > dur {
		return dur
	}
	return to
}

// Run executes the compiled plan, forwarding ffmpeg -progress to the job.
func Run(ctx context.Context, j *jobs.Job, plan *Plan) error {
	j.Log("ffmpeg " + strings.Join(plan.Args, " "))
	cmd := exec.CommandContext(ctx, "ffmpeg", plan.Args...)
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			if strings.HasPrefix(line, "out_time_ms=") {
				var us float64
				fmt.Sscanf(line, "out_time_ms=%f", &us)
				if plan.Dur > 0 {
					j.Progress(math.Min(0.99, (us/1e6)/plan.Dur), "encoding")
				}
			}
		}
	}()
	var errBuf strings.Builder
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			errBuf.WriteString(sc.Text() + "\n")
		}
	}()
	if err := cmd.Wait(); err != nil {
		return fmt.Errorf("ffmpeg: %w: %s", err, strings.TrimSpace(errBuf.String()))
	}
	if _, err := os.Stat(plan.Args[len(plan.Args)-1]); err != nil {
		return fmt.Errorf("no output produced")
	}
	return nil
}

// ffColor converts "#rrggbb" to ffmpeg's "0xRRGGBB"; passes names through.
func ffColor(c string) string {
	if strings.HasPrefix(c, "#") {
		return "0x" + strings.ToUpper(c[1:])
	}
	return c
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
