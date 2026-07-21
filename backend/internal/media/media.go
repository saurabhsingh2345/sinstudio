// Package media wraps ffprobe/ffmpeg for probing assets and making thumbnails.
package media

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

// Info describes a probed media file.
type Info struct {
	Kind     string  // video|audio|image
	Duration float64 // seconds
	Width    int
	Height   int
	HasAlpha bool
	HasAudio bool // an audible audio stream is present
}

type ffprobeOut struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		PixFmt      string `json:"pix_fmt"`
		Duration    string `json:"duration"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// alphaPixFmts are pixel formats that carry an alpha channel.
var alphaPixFmts = map[string]bool{
	"yuva420p": true, "yuva422p": true, "yuva444p": true,
	"rgba": true, "bgra": true, "argb": true, "abgr": true,
	"ya8": true, "pal8": true,
}

// Probe runs ffprobe and summarizes the file.
func Probe(ctx context.Context, path string) (*Info, error) {
	cmd := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-print_format", "json",
		"-show_format", "-show_streams",
		path,
	)
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe %s: %w", path, err)
	}
	var p ffprobeOut
	if err := json.Unmarshal(out, &p); err != nil {
		return nil, err
	}
	info := &Info{Kind: "audio"}
	if d, err := strconv.ParseFloat(strings.TrimSpace(p.Format.Duration), 64); err == nil {
		info.Duration = d
	}
	hasVideo := false
	for _, s := range p.Streams {
		if s.CodecType == "audio" {
			info.HasAudio = true
		}
		// Embedded cover art (mp3 thumbnails) is a video stream too — skip it.
		if s.CodecType == "video" && s.Disposition.AttachedPic == 0 {
			hasVideo = true
			info.Width, info.Height = s.Width, s.Height
			if alphaPixFmts[s.PixFmt] {
				info.HasAlpha = true
			}
			// Some containers (e.g. MediaRecorder output) omit the format-level
			// duration; fall back to the stream duration before deciding kind.
			if info.Duration == 0 {
				if d, err := strconv.ParseFloat(strings.TrimSpace(s.Duration), 64); err == nil {
					info.Duration = d
				}
			}
		}
	}
	if hasVideo {
		// A real video stream with any duration (or a soundtrack) is a video;
		// only a lone still frame with no duration and no audio is an image.
		if info.Duration > 0 || info.HasAudio {
			info.Kind = "video"
		} else {
			info.Kind = "image"
		}
	}
	// Streamed containers (MediaRecorder downloads) can carry no duration at
	// all; decoding is the only way to measure them.
	if info.Duration == 0 && info.Kind != "image" {
		info.Duration = decodeDuration(ctx, path)
	}
	return info, nil
}

var decodeTimeRe = regexp.MustCompile(`time=(\d+):(\d+):(\d+(?:\.\d+)?)`)

// decodeDuration runs the file through a null decode and reads the last
// progress timestamp ffmpeg reports.
func decodeDuration(ctx context.Context, path string) float64 {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-i", path, "-f", "null", "-")
	out, _ := cmd.CombinedOutput()
	var dur float64
	for _, m := range decodeTimeRe.FindAllStringSubmatch(string(out), -1) {
		h, _ := strconv.ParseFloat(m[1], 64)
		mn, _ := strconv.ParseFloat(m[2], 64)
		sec, _ := strconv.ParseFloat(m[3], 64)
		if d := h*3600 + mn*60 + sec; d > dur {
			dur = d
		}
	}
	return dur
}

// NeedsRemux reports whether a container should be rewritten before use.
//
// A browser MediaRecorder streams its output and can never seek back to finish
// the header, so what it produces carries no duration and no seek index. The
// probe can recover a duration by decoding the whole file, but nothing recovers
// seeking: the preview drives <video>.currentTime on every playhead move, and a
// cue-less WebM scrubs badly or not at all.
func NeedsRemux(path string) bool {
	return strings.EqualFold(filepath.Ext(path), ".webm")
}

// Remux rewrites a container without touching the streams, which is what
// restores the duration and seek index a streamed recording never got. It is
// lossless and I/O-bound — cheap enough to run inline on upload — because the
// codecs are copied rather than re-encoded.
func Remux(ctx context.Context, src, dst string) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", "-y", "-loglevel", "error",
		"-fflags", "+genpts", // a streamed capture can arrive without timestamps
		"-i", src,
		"-c", "copy",
		dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("remux: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// RemuxInPlace repairs a file where it sits. The rewrite goes to a temporary
// sibling and is renamed over the original only on success, so a failed repair
// leaves the upload exactly as it arrived — an unseekable recording is a poor
// clip, but a deleted one is no clip at all.
func RemuxInPlace(ctx context.Context, path string) error {
	tmp := path + ".remux" + filepath.Ext(path)
	if err := Remux(ctx, path, tmp); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// Thumbnail writes a single representative JPEG frame for the asset.
func Thumbnail(ctx context.Context, src, dst string, atSeconds float64) error {
	args := []string{"-y", "-loglevel", "error"}
	if atSeconds > 0 {
		args = append(args, "-ss", fmt.Sprintf("%.3f", atSeconds))
	}
	args = append(args,
		"-i", src,
		"-frames:v", "1",
		"-vf", "scale=320:-2:flags=bicubic",
		dst,
	)
	cmd := exec.CommandContext(ctx, "ffmpeg", args...)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("thumbnail: %v: %s", err, string(out))
	}
	return nil
}
