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
	"sync"

	"studio/internal/jobs"
	"studio/internal/schema"
)

// AssetResolver maps an asset id to an absolute file path on disk.
type AssetResolver func(assetID string) (string, bool)

// Options tune a single export (preset geometry, container format, range).
type Options struct {
	Preset   string  `json:"preset"`   // "" (source) | shorts | square | 4k | portrait4k
	Format   string  `json:"format"`   // "" (mp4) | mp4 | webm | gif | mov
	From     float64 `json:"from"`     // range start seconds
	To       float64 `json:"to"`       // range end seconds (0 = end)
	FPS      int     `json:"fps"`      // override output fps (0 = doc fps)
	FrameAt  float64 `json:"frameAt"`  // >0: render a single PNG frame at this time
	Loudnorm bool    `json:"loudnorm"` // apply EBU R128 loudness normalization to the mix
	// LUTDir is the directory holding a project's .cube LUT files (set server-side,
	// never from the client). A clip's LUT name is resolved under it.
	LUTDir string `json:"-"`
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
	cx, cy            int                          // anchored base position (no offset) for keyframes
	ax, ay            float64                      // scale origin as a 0..1 fraction of the box (0.5 = center)
	rot               float64                      // clockwise rotation in degrees about center (0 = none)
	keyframes         map[string][]schema.Keyframe // property -> control points (clip-local t)
	effects           *schema.Effects
	lut               string  // absolute path to a .cube LUT, or "" for none
	still             bool    // input is a looped still image (title), not a trimmed video
	hold              float64 // seconds of frozen last frame appended after the source span
}

// audio is a resolved audio contribution.
type audio struct {
	path            string
	in, out         float64
	start           float64
	volume          float64
	speed           float64
	fadeIn, fadeOut float64
	duck            bool // true = a music/bed track that ducks under voice
	eq              *schema.AudioEQ
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
				if c.Disabled {
					continue
				}
				addClip(&visuals, &audios, c, resolve, w, h, true, t.Muted, t.Duck, opts.LUTDir)
			}
		case schema.TrackVideo, schema.TrackOverlay:
			for _, c := range t.Clips {
				if c.Disabled {
					continue
				}
				if c.Title != nil {
					if err := addTitleClip(&visuals, c, w, h, srtDir, titleIdx); err == nil {
						titleIdx++
					}
					continue
				}
				addClip(&visuals, &audios, c, resolve, w, h, false, t.Muted, t.Duck, opts.LUTDir)
			}
		case schema.TrackAudio:
			if t.Muted {
				continue
			}
			for _, c := range t.Clips {
				if c.Disabled {
					continue
				}
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
					speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut, duck: t.Duck,
					eq: c.EQ,
				})
			}
		case schema.TrackCaption:
			cues = append(cues, t.Cues...)
		}
	}

	// Drop audio contributions whose source has no audio stream (e.g. silent
	// template clips) — referencing [N:a] on such an input aborts the whole render.
	// If ffprobe isn't on PATH we can't tell, so fail open (keep all audio) rather
	// than silently exporting a muted video.
	if _, probeErr := exec.LookPath("ffprobe"); probeErr != nil {
		// leave audios untouched
	} else if len(audios) > 0 {
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

	// Validate/normalize the optional export range against the real duration so a
	// bad From/To can't produce a negative -t (which FFmpeg rejects) or an empty clip.
	if opts.From < 0 {
		opts.From = 0
	}
	if opts.From >= dur {
		return nil, fmt.Errorf("export range start %.3fs is at/after the timeline end %.3fs", opts.From, dur)
	}
	if opts.To > 0 && opts.To <= opts.From {
		return nil, fmt.Errorf("export range end %.3fs must be after start %.3fs", opts.To, opts.From)
	}
	if opts.FrameAt < 0 || opts.FrameAt >= dur {
		if opts.FrameAt >= dur {
			// Clamp a past-the-end frame grab back onto the LAST REAL FRAME. Backing
			// off by a hair (dur-0.001) lands between the final frame and the end of
			// the stream, so `-ss` finds nothing to decode and ffmpeg writes an empty
			// file — which is what an all-disabled/empty timeline used to produce.
			opts.FrameAt = math.Max(0, dur-1.0/float64(fps))
		} else {
			opts.FrameAt = 0
		}
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
		// Scale — animated (scale=eval=frame, re-evaluated per frame) when the clip
		// has scale keyframes, else a one-time resize to the clip's base size.
		scaleActive := len(v.keyframes["scale"]) > 0
		scaleSeg := fmt.Sprintf("scale=%d:%d:flags=bicubic", v.sw, v.sh)
		if scaleActive {
			se := kfScaleExpr(v.start, v.keyframes["scale"])
			scaleSeg = fmt.Sprintf("scale=w='max(2,%d*%s)':h='max(2,%d*%s)':eval=frame:flags=bicubic", w, se, h, se)
		}
		if v.still {
			// Looped still (title PNG): bound to its span, PTS shifted to start.
			args = append(args, "-loop", "1", "-t", fmt.Sprintf("%.3f", v.end-v.start), "-i", v.path)
			fmt.Fprintf(&fc,
				"[%d:v]setpts=PTS-STARTPTS+%.3f/TB,%s,format=rgba",
				inputIdx, v.start, scaleSeg)
		} else {
			args = append(args, "-i", v.path)
			fmt.Fprintf(&fc,
				"[%d:v]trim=start=%.3f:end=%.3f,setpts=(PTS-STARTPTS)/%.4f+%.3f/TB,%s,format=rgba",
				inputIdx, v.in, v.out, sp, v.start, scaleSeg)
			// Hold: clone the last frame for `hold` more seconds so the clip covers
			// trailing audio with a freeze-frame instead of cutting to background.
			if v.hold > 0 {
				fmt.Fprintf(&fc, ",tpad=stop_mode=clone:stop_duration=%.3f", v.hold)
			}
		}
		// Rotation about the clip's center. format=rgba first so the corners exposed
		// by the rotation are transparent (c=none), not black. Positioning below
		// re-centers dynamically, since either form grows the box.
		rotActive := len(v.keyframes["rotation"]) > 0
		switch {
		case rotActive:
			// Animated: `rotate` re-evaluates its angle per frame, but ow/oh are
			// evaluated once at config time — so they can't track the live angle.
			// Size the box to the diagonal, which contains the frame at *any* angle;
			// this also stays correct under overshoot easings that swing past the
			// keyed values.
			fmt.Fprintf(&fc, ",format=rgba,rotate=a=%s:ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none",
				kfRotExpr(v.start, v.keyframes["rotation"]))
		case v.rot != 0:
			// Static: rotw/roth size the box exactly to the rotated content.
			rad := v.rot * math.Pi / 180
			fmt.Fprintf(&fc, ",format=rgba,rotate=%.6f:ow=rotw(%.6f):oh=roth(%.6f):c=none", rad, rad, rad)
		}
		// Opacity: animated alpha via geq when keyframed, else a constant multiplier.
		if okf := v.keyframes["opacity"]; len(okf) > 0 {
			fmt.Fprintf(&fc,
				",geq=r='p(X,Y)':g='p(X,Y)':b='p(X,Y)':a='p(X,Y)*clip(%s,0,1)'",
				kfOpacityExpr(v.start, okf))
		} else {
			fmt.Fprintf(&fc, ",colorchannelmixer=aa=%.3f", v.opacity)
		}
		// Per-clip color/blur effects, then an optional 3D LUT (color grade).
		fc.WriteString(effectFilters(v.effects))
		if v.lut != "" {
			fmt.Fprintf(&fc, ",lut3d=file=%s", escapeFilterPath(v.lut))
		}
		// Alpha fade in/out — driven by fade/dissolve transitions or explicit fades.
		if tr.alphaIn > 0 {
			fmt.Fprintf(&fc, ",fade=t=in:st=%.3f:d=%.3f:alpha=1", v.start, tr.alphaIn)
		}
		if tr.alphaOut > 0 {
			fmt.Fprintf(&fc, ",fade=t=out:st=%.3f:d=%.3f:alpha=1", math.Max(v.start, v.end-tr.alphaOut), tr.alphaOut)
		}
		fmt.Fprintf(&fc, "%s;", lbl)
		out := fmt.Sprintf("[b%d]", i)
		// Position — motion keyframes win per axis, else a slide expression, else
		// static. When scale is animated the anchor must track the clip's live
		// size, so use overlay's own w/h ("ax*(W-w)") instead of the static base.
		// Rotation (like scale animation) grows the overlay box, so it too has to
		// track the live size rather than the static pre-transform position.
		dynCenter := scaleActive || rotActive || v.rot != 0
		cxExpr, cyExpr := fmt.Sprintf("%d", v.cx), fmt.Sprintf("%d", v.cy)
		if dynCenter {
			cxExpr = fmt.Sprintf("%.4f*(W-w)", v.ax)
			cyExpr = fmt.Sprintf("%.4f*(H-h)", v.ay)
		}
		var xPos, yPos string
		switch {
		case len(v.keyframes["x"]) > 0:
			xPos = kfExpr(cxExpr, v.start, v.keyframes["x"])
		case dynCenter:
			xPos = axisPosDyn(cxExpr, v.x-v.cx, v.start, v.end, tr.xInOff, tr.xInDur, tr.xOutOff, tr.xOutDur)
		default:
			xPos = axisPos(v.x, v.start, v.end, tr.xInOff, tr.xInDur, tr.xOutOff, tr.xOutDur)
		}
		switch {
		case len(v.keyframes["y"]) > 0:
			yPos = kfExpr(cyExpr, v.start, v.keyframes["y"])
		case dynCenter:
			yPos = axisPosDyn(cyExpr, v.y-v.cy, v.start, v.end, tr.yInOff, tr.yInDur, tr.yOutOff, tr.yOutDur)
		default:
			yPos = axisPos(v.y, v.start, v.end, tr.yInOff, tr.yInDur, tr.yOutOff, tr.yOutDur)
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

	// Audio graph: trim, speed (atempo), volume, fades, delay, then mix. Sources
	// split into "voice" (everything) and "duck" (music/bed tracks) so the bed
	// can be sidechain-compressed under the voice.
	audioLabels := []string{}
	voiceLabels := []string{}
	duckLabels := []string{}
	// A single-frame grab maps only the video label; building the audio graph
	// anyway would leave amix's output unconnected, which ffmpeg rejects.
	if !gif && opts.FrameAt <= 0 {
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
			fc.WriteString(eqFilters(a.eq))
			if a.fadeIn > 0 {
				fmt.Fprintf(&fc, ",afade=t=in:st=0:d=%.3f", a.fadeIn)
			}
			if a.fadeOut > 0 {
				fmt.Fprintf(&fc, ",afade=t=out:st=%.3f:d=%.3f", math.Max(0, span-a.fadeOut), a.fadeOut)
			}
			fmt.Fprintf(&fc, ",adelay=%d|%d%s;", ms, ms, lbl)
			audioLabels = append(audioLabels, lbl)
			if a.duck {
				duckLabels = append(duckLabels, lbl)
			} else {
				voiceLabels = append(voiceLabels, lbl)
			}
			inputIdx++
		}
	}
	haveAudio := len(audioLabels) > 0
	// mix folds a label set into one stream (a passthrough when it's a single
	// label), emitting an amix into `out` only when there's more than one.
	mix := func(labels []string, out string) string {
		if len(labels) == 1 {
			return labels[0]
		}
		fmt.Fprintf(&fc, "%samix=inputs=%d:normalize=0:dropout_transition=0%s;",
			strings.Join(labels, ""), len(labels), out)
		return out
	}
	if haveAudio {
		if len(duckLabels) > 0 && len(voiceLabels) > 0 {
			// Auto-duck: compress the music bed with the voice as the sidechain key.
			vmix := mix(voiceLabels, "[vmix]")
			fmt.Fprintf(&fc, "%sasplit=2[vout][vkey];", vmix)
			dmix := mix(duckLabels, "[dmix]")
			fmt.Fprintf(&fc, "%s[vkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=300[ducked];", dmix)
			fmt.Fprintf(&fc, "[vout][ducked]amix=inputs=2:normalize=0:dropout_transition=0[amix];")
		} else {
			fmt.Fprintf(&fc, "%samix=inputs=%d:normalize=0:dropout_transition=0[amix];",
				strings.Join(audioLabels, ""), len(audioLabels))
		}
	}

	// ---- finalize: range trim, preset scale/pad, gif palette ----
	outW, outH := presetDims(opts.Preset, w, h)
	rangeActive := opts.From > 0 || (opts.To > 0 && opts.To < dur)
	presetActive := outW != w || outH != h
	vlab := base // current video label
	alab := "[amix]"

	// Only produce a graph video label if we have clips/captions or need finalize.
	// An audio-only project (music over a bare background) still builds a
	// filtergraph, so the background must be routed through a passthrough too —
	// otherwise the bare "[0:v]" input pad gets mapped as a filter label.
	hasVideoGraph := len(visuals) > 0 || strings.Contains(fc.String(), "[c") || rangeActive || presetActive || gif || haveAudio
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
	// EBU R128 loudness normalization on the final mix (streaming target −16 LUFS).
	if opts.Loudnorm && haveAudio && !gif {
		fmt.Fprintf(&fc, "%sloudnorm=I=-16:TP=-1.5:LRA=11[aout];", alab)
		alab = "[aout]"
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

func addClip(visuals *[]visual, audios *[]audio, c schema.Clip, resolve AssetResolver, w, h int, isBG, muted, duck bool, lutDir string) {
	p, ok := resolve(c.AssetID)
	if !ok {
		return
	}
	lut := ""
	if c.LUT != "" && lutDir != "" {
		lut = filepath.Join(lutDir, filepath.Base(c.LUT)) // base-sanitized: no path escape
	}
	span := playSpan(c.In, c.Out, c.Speed)
	if span <= 0 {
		return
	}
	hold := c.Hold
	if hold < 0 {
		hold = 0
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
	// The anchor is the point scaling holds fixed: at anchor fraction a, the box
	// sits at a*(canvas-box), which is the old (canvas-box)/2 when a = 0.5.
	ax, ay := c.Transform.AnchorFrac()
	cx, cy := int(ax*float64(w-sw)), int(ay*float64(h-sh))
	x := cx + int(c.Transform.X)
	y := cy + int(c.Transform.Y)
	if isBG {
		sw, sh, x, y, cx, cy = w, h, 0, 0, 0, 0
		ax, ay = 0.5, 0.5
	}
	*visuals = append(*visuals, visual{
		path: p, in: c.In, out: c.Out, start: c.Start, end: c.Start + span + hold,
		x: x, y: y, sw: sw, sh: sh, opacity: op,
		speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut,
		transIn: c.TransitionIn, transOut: c.TransitionOut,
		cx: cx, cy: cy, ax: ax, ay: ay,
		rot: c.Transform.Rotation, keyframes: c.Keyframes, effects: c.Effects, lut: lut,
		hold: hold,
	})
	if !muted && !isBG && !c.Mute {
		vol := c.Volume
		if vol == 0 {
			vol = 1
		}
		*audios = append(*audios, audio{
			path: p, in: c.In, out: c.Out, start: c.Start, volume: vol,
			speed: c.Speed, fadeIn: c.FadeIn, fadeOut: c.FadeOut, duck: duck,
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

// axisPosDyn builds an overlay coordinate around a dynamic center expression
// (e.g. "(W-w)/2", which re-centers as the clip's size animates) plus a constant
// px offset, honoring slide transitions. Used when a clip has scale keyframes.
func axisPosDyn(center string, off int, S, E float64, inOff string, inDur float64, outOff string, outDur float64) string {
	target := fmt.Sprintf("(%s+%d)", center, off)
	if inOff == "" && outOff == "" {
		return "'" + target + "'"
	}
	expr := target
	if outOff != "" && outDur > 0 { // exit: target -> edge over [E-dur, E]
		st := E - outDur
		ramp := fmt.Sprintf("(%s+((%s)-%s)*(t-%.3f)/%.3f)", target, outOff, target, st, outDur)
		expr = fmt.Sprintf("if(gte(t,%.3f),%s,%s)", st, ramp, expr)
	}
	if inOff != "" && inDur > 0 { // entrance: edge -> target over [S, S+dur]
		ramp := fmt.Sprintf("((%s)+(%s-(%s))*(t-%.3f)/%.3f)", inOff, target, inOff, S, inDur)
		expr = fmt.Sprintf("if(lt(t,%.3f),%s,%s)", S+inDur, ramp, expr)
	}
	return "'" + expr + "'"
}

// escapeFilterPath wraps a file path for use as an ffmpeg filter option value
// (e.g. lut3d=file=...), single-quoting it so spaces/colons are literal and
// escaping backslashes and quotes per the filtergraph escaping rules.
func escapeFilterPath(p string) string {
	r := strings.NewReplacer(`\`, `\\`, `'`, `\'`)
	return "'" + r.Replace(p) + "'"
}

// eqFilters emits the ffmpeg audio-EQ chain (bass/equalizer/treble) for a clip's
// 3-band EQ (empty when nil or flat). Leading comma so it appends to the clip's
// audio filter string. Gains are clamped to ±24 dB for safety.
func eqFilters(eq *schema.AudioEQ) string {
	if eq == nil {
		return ""
	}
	clamp := func(g float64) float64 { return math.Max(-24, math.Min(24, g)) }
	var b strings.Builder
	if eq.Low != 0 {
		fmt.Fprintf(&b, ",bass=g=%.2f:f=100", clamp(eq.Low))
	}
	if eq.Mid != 0 {
		fmt.Fprintf(&b, ",equalizer=f=1000:t=q:w=1:g=%.2f", clamp(eq.Mid))
	}
	if eq.High != 0 {
		fmt.Fprintf(&b, ",treble=g=%.2f:f=8000", clamp(eq.High))
	}
	return b.String()
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

// easeProgress wraps a normalized progress expression p (a string evaluating to
// [0,1]) into an eased 0..1 expression per the named curve. The shapes mirror
// newaniAdv/lib/motion.ts so preview, that engine, and this export agree.
func easeProgress(ease, p string) string {
	switch ease {
	case "easeInCubic":
		return fmt.Sprintf("pow(%s,3)", p)
	case "easeOutCubic":
		return fmt.Sprintf("(1-pow(1-(%s),3))", p)
	case "easeInOut": // quintic smootherstep x^3*(x*(6x-15)+10)
		return fmt.Sprintf("(pow(%s,3)*((%s)*((%s)*6-15)+10))", p, p, p)
	case "easeOutBack": // one overshoot then settle (c3 = 2.70158)
		return fmt.Sprintf("(1+2.70158*pow((%s)-1,3)+1.70158*pow((%s)-1,2))", p, p)
	case "easeOutElastic": // decaying oscillation (c4 = 2π/3)
		return fmt.Sprintf("(pow(2,-10*(%s))*sin(((%s)*10-0.75)*2.0943951)+1)", p, p)
	case "springOut": // soft single-overshoot settle; pinned to 0 at p=0
		return fmt.Sprintf("if(lte(%s,0),0,(1+pow(2,-9*(%s))*sin(((%s)*8-0.75)*1.8479957)*0.9))", p, p, p)
	default: // linear
		return "(" + p + ")"
	}
}

// kfPiecewise compiles keyframes into a piecewise function of clip-local time,
// eased per the LEFT keyframe's curve and holding the first/last value outside
// the keyed range — the exact shape kfValue() interpolates in the browser.
//
// timeVar is the filter's own time variable: "t" for most filters, "T" inside
// geq. The result is bare; callers wrap, quote, and unit-convert it. Note that
// an ffmpeg filter argument containing commas must be single-quoted, which is
// why every wrapper below either quotes or is used inside a quoted context.
func kfPiecewise(timeVar string, S float64, kfs []schema.Keyframe) string {
	pts := append([]schema.Keyframe(nil), kfs...)
	sort.SliceStable(pts, func(i, j int) bool { return pts[i].T < pts[j].T })
	if len(pts) == 1 {
		return fmt.Sprintf("%.4f", pts[0].Value)
	}
	local := fmt.Sprintf("(%s-%.3f)", timeVar, S)
	expr := fmt.Sprintf("%.4f", pts[len(pts)-1].Value) // innermost: hold the last
	for i := len(pts) - 2; i >= 0; i-- {
		a, b := pts[i], pts[i+1]
		dt := math.Max(b.T-a.T, 1e-3)
		p := easeProgress(a.Ease, fmt.Sprintf("(%s-%.3f)/%.3f", local, a.T, dt))
		seg := fmt.Sprintf("(%.4f+(%.4f)*%s)", a.Value, b.Value-a.Value, p)
		expr = fmt.Sprintf("if(lt(%s,%.3f),%s,%s)", local, b.T, seg, expr)
	}
	// Before the first key: hold the first value.
	return fmt.Sprintf("if(lt(%s,%.3f),%.4f,%s)", local, pts[0].T, pts[0].Value, expr)
}

// kfExpr compiles position keyframes into an overlay coordinate: a base position
// (a plain integer anchor, or a dynamic "ax*(W-w)" expression when the clip's
// size animates) plus the keyed offset. Values are canvas-px offsets from the
// anchored base.
func kfExpr(base string, S float64, kfs []schema.Keyframe) string {
	return fmt.Sprintf("'(%s+%s)'", base, kfPiecewise("t", S, kfs))
}

// kfScaleExpr compiles scale keyframes into a bare multiplier expression for a
// scale filter in eval=frame mode. A keyframe Value is an absolute scale
// multiplier (1 = canvas-fit), overriding the clip's static Transform.Scale.
// Negative values need no guard here — the call site clamps to max(2,…) px.
func kfScaleExpr(S float64, kfs []schema.Keyframe) string {
	return "(" + kfPiecewise("t", S, kfs) + ")"
}

// kfRotExpr compiles rotation keyframes into an angle expression for the rotate
// filter, which re-evaluates its angle every frame. Keyframe values are degrees
// (matching Transform.Rotation); rotate wants radians.
func kfRotExpr(S float64, kfs []schema.Keyframe) string {
	return fmt.Sprintf("'((%s)*%.10f)'", kfPiecewise("t", S, kfs), math.Pi/180)
}

// addTitleClip renders a text clip to a PNG and appends it as a still visual so
// it flows through the same transform/transition/keyframe/effect/fade pipeline.
//
// When Title.Reveal is set, the text builds on progressively: a sequence of
// prefix PNGs is composited, each shown for its slice of the reveal window (the
// full text then holds to the end). A reveal can't be expressed as transform
// keyframes on one still, so it bypasses the keyframe/transition path.
func addTitleClip(visuals *[]visual, c schema.Clip, w, h int, srtDir string, idx int) error {
	span := c.Out - c.In
	if span <= 0 {
		span = 3
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
	ax, ay := c.Transform.AnchorFrac()
	cx, cy := int(ax*float64(w-sw)), int(ay*float64(h-sh))
	x, y := cx+int(c.Transform.X), cy+int(c.Transform.Y)

	reveal := strings.TrimSpace(c.Title.Reveal)
	if reveal == "" {
		png := filepath.Join(srtDir, fmt.Sprintf("title-%d.png", idx))
		if err := renderTitlePNG(*c.Title, w, h, png); err != nil {
			return err
		}
		*visuals = append(*visuals, visual{
			path: png, start: c.Start, end: c.Start + span,
			x: x, y: y, sw: sw, sh: sh, opacity: op,
			fadeIn: c.FadeIn, fadeOut: c.FadeOut,
			transIn: c.TransitionIn, transOut: c.TransitionOut,
			cx: cx, cy: cy, ax: ax, ay: ay,
			rot: c.Transform.Rotation, keyframes: c.Keyframes, effects: c.Effects,
			still: true,
		})
		return nil
	}

	// Progressive text reveal. Build over ~70% of the clip; the last (full) step
	// holds until the end.
	bounds := titleRevealSteps(c.Title.Text, reveal)
	n := len(bounds)
	rd := span * 0.7
	if rd < 0.4 {
		rd = math.Min(span, 0.4)
	}
	stepDur := rd / float64(n)
	for k, revealChars := range bounds {
		png := filepath.Join(srtDir, fmt.Sprintf("title-%d-%d.png", idx, k))
		if err := renderTitleCore(*c.Title, w, h, png, revealChars); err != nil {
			return err
		}
		start := c.Start + float64(k)*stepDur
		end := c.Start + float64(k+1)*stepDur
		fadeIn, fadeOut := 0.0, 0.0
		if k == 0 {
			fadeIn = c.FadeIn
		}
		if k == n-1 {
			end = c.Start + span // full text holds to the end
			fadeOut = c.FadeOut
		}
		*visuals = append(*visuals, visual{
			path: png, start: start, end: end,
			x: x, y: y, sw: sw, sh: sh, opacity: op,
			fadeIn: fadeIn, fadeOut: fadeOut,
			cx: cx, cy: cy, ax: ax, ay: ay,
			rot: c.Transform.Rotation, effects: c.Effects,
			still: true,
		})
	}
	return nil
}

// titleRevealSteps returns the cumulative character counts to reveal at each
// step (last element is -1 = "show all"), for either a per-character
// ("typewriter") or per-word build-on. Steps are capped so long text doesn't
// explode the filtergraph.
func titleRevealSteps(text, mode string) []int {
	runes := []rune(text)
	total := len(runes)
	if total == 0 {
		return []int{-1}
	}
	const maxSteps = 48
	var bounds []int
	if mode == "word" {
		inWord := false
		for i, r := range runes {
			space := r == ' ' || r == '\n' || r == '\t'
			if !space {
				inWord = true
			} else if inWord {
				bounds = append(bounds, i)
				inWord = false
			}
		}
		if inWord {
			bounds = append(bounds, total)
		}
	} else { // typewriter
		step := 1
		if total > maxSteps {
			step = int(math.Ceil(float64(total) / float64(maxSteps)))
		}
		for i := step; i < total; i += step {
			bounds = append(bounds, i)
		}
		bounds = append(bounds, total)
	}
	if len(bounds) == 0 {
		bounds = []int{total}
	}
	// Subsample if we overshot the cap.
	if len(bounds) > maxSteps {
		sub := make([]int, 0, maxSteps)
		for i := 0; i < maxSteps; i++ {
			sub = append(sub, bounds[i*len(bounds)/maxSteps])
		}
		bounds = sub
	}
	bounds[len(bounds)-1] = -1 // final step always shows the complete text
	return bounds
}

// kfOpacityExpr builds a bare piecewise 0..1 expression for animating a clip's
// alpha. geq exposes time as T rather than t.
func kfOpacityExpr(S float64, kfs []schema.Keyframe) string {
	return kfPiecewise("T", S, kfs)
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
	// Both pipes must be drained to EOF before Wait: exec closes them there, and
	// Wait returning is no guarantee that these goroutines have finished writing.
	// Reading errBuf without that guarantee is a data race, and the practical
	// symptom is the worst possible one — a truncated ffmpeg error at exactly the
	// moment you need the whole thing to diagnose a failed export.
	var readers sync.WaitGroup
	readers.Add(2)
	go func() {
		defer readers.Done()
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
		defer readers.Done()
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			errBuf.WriteString(sc.Text() + "\n")
		}
	}()
	readers.Wait()
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
