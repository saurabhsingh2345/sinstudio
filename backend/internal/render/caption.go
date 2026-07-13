package render

import (
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"

	"golang.org/x/image/font"
	"golang.org/x/image/font/opentype"
	"golang.org/x/image/math/fixed"

	"studio/internal/schema"
)

// candidateFonts are tried in order for caption rendering.
var candidateFonts = []string{
	"/System/Library/Fonts/Supplemental/Arial.ttf",
	"/System/Library/Fonts/Supplemental/Helvetica.ttf",
	"/Library/Fonts/Arial.ttf",
	"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
	"/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
}

func fontPath() string {
	if p := os.Getenv("CAPTION_FONT"); p != "" {
		return p
	}
	for _, p := range candidateFonts {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func newFace(size float64) (font.Face, error) {
	p := fontPath()
	if p == "" {
		return nil, os.ErrNotExist
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, err
	}
	f, err := opentype.Parse(data)
	if err != nil {
		return nil, err
	}
	return opentype.NewFace(f, &opentype.FaceOptions{Size: size, DPI: 72, Hinting: font.HintingFull})
}

// renderCaptionPNG draws one cue as a full-canvas transparent PNG with an
// outlined, word-wrapped, horizontally-centered caption at style.PosY.
func renderCaptionPNG(cue schema.CaptionCue, w, h int, outPath string) error {
	size := float64(cue.Style.Size)
	if size <= 0 {
		size = 24
	}
	// Scale caption size relative to a 1080-tall reference so it reads at any res.
	size = size * float64(h) / 1080.0
	face, err := newFace(size)
	if err != nil {
		return err
	}
	defer face.Close()

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	maxW := int(float64(w) * 0.9)
	lines := wrapText(cue.Text, face, maxW)

	lineH := int(size * 1.3)
	blockH := lineH * len(lines)
	// Default unset PosY to a lower-third position (matching the editor default)
	// so captions with a zero style don't burn at the very top and clip.
	posY := cue.Style.PosY
	if posY <= 0 {
		posY = 0.85
	}
	startY := int(posY*float64(h)) - blockH/2 + lineH*3/4

	fg := parseHexColor(cue.Style.Color, color.White)
	outline := color.RGBA{0, 0, 0, 220}

	for i, line := range lines {
		tw := textWidth(face, line)
		x := (w - tw) / 2
		y := startY + i*lineH
		// outline: draw the line offset in 8 directions
		off := maxInt(1, int(size/12))
		for dx := -off; dx <= off; dx++ {
			for dy := -off; dy <= off; dy++ {
				if dx == 0 && dy == 0 {
					continue
				}
				drawString(img, face, line, x+dx, y+dy, outline)
			}
		}
		drawString(img, face, line, x, y, fg)
	}

	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

// renderTitlePNG draws a Title as a full-canvas transparent PNG: word-wrapped,
// aligned text (with an outline, optional background band) at style.PosY. The
// clip's transform/transitions/keyframes then animate this layer.
func renderTitlePNG(t schema.Title, w, h int, outPath string) error {
	return renderTitleCore(t, w, h, outPath, -1)
}

// renderTitleCore renders a title, showing only the first revealChars characters
// of the (wrapped) text when revealChars >= 0. Layout is always computed from the
// FULL text, so a partial reveal never reflows — characters appear in place, as
// in a typewriter. revealChars < 0 shows everything.
func renderTitleCore(t schema.Title, w, h int, outPath string, revealChars int) error {
	size := float64(t.Size)
	if size <= 0 {
		size = 64
	}
	size = size * float64(h) / 1080.0
	face, err := newFace(size)
	if err != nil {
		return err
	}
	defer face.Close()

	img := image.NewRGBA(image.Rect(0, 0, w, h))
	margin := int(float64(w) * 0.05)
	maxW := w - 2*margin
	lines := wrapText(t.Text, face, maxW)

	lineH := int(size * 1.3)
	blockH := lineH * len(lines)
	posY := t.PosY
	if posY <= 0 {
		posY = 0.5
	}
	startY := int(posY*float64(h)) - blockH/2 + lineH*3/4

	// optional background band behind the text block (drawn at full extent even
	// during a reveal, so the band doesn't grow as text appears)
	if bg := strings.TrimSpace(t.Background); bg != "" {
		band := parseHexColor(bg, color.Black)
		pad := int(size * 0.35)
		y0 := startY - lineH*3/4 - pad
		y1 := startY - lineH*3/4 + blockH + pad
		fillRect(img, 0, maxInt(0, y0), w, minInt2(h, y1), band)
	}

	fg := parseHexColor(t.Color, color.White)
	outline := color.RGBA{0, 0, 0, 220}
	off := maxInt(1, int(size/12))
	if t.Bold {
		off = maxInt(2, int(size/8))
	}

	remaining := revealChars // characters left to draw across all lines (-1 = all)
	for i, line := range lines {
		draw := line
		if revealChars >= 0 {
			runes := []rune(line)
			n := remaining
			if n > len(runes) {
				n = len(runes)
			}
			if n < 0 {
				n = 0
			}
			draw = string(runes[:n])
			remaining -= len([]rune(line)) + 1 // +1 for the wrapped line break
		}
		// Center/align using the FULL line width so the revealed prefix stays put.
		tw := textWidth(face, line)
		var x int
		switch t.Align {
		case "left":
			x = margin
		case "right":
			x = w - margin - tw
		default:
			x = (w - tw) / 2
		}
		y := startY + i*lineH
		if draw == "" {
			continue
		}
		for dx := -off; dx <= off; dx++ {
			for dy := -off; dy <= off; dy++ {
				if dx == 0 && dy == 0 {
					continue
				}
				drawString(img, face, draw, x+dx, y+dy, outline)
			}
		}
		drawString(img, face, draw, x, y, fg)
	}

	f, err := os.Create(outPath)
	if err != nil {
		return err
	}
	defer f.Close()
	return png.Encode(f, img)
}

func fillRect(img *image.RGBA, x0, y0, x1, y1 int, c color.Color) {
	for y := y0; y < y1; y++ {
		for x := x0; x < x1; x++ {
			img.Set(x, y, c)
		}
	}
}

func minInt2(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func drawString(dst *image.RGBA, face font.Face, s string, x, y int, c color.Color) {
	d := &font.Drawer{
		Dst:  dst,
		Src:  image.NewUniform(c),
		Face: face,
		Dot:  fixed.P(x, y),
	}
	d.DrawString(s)
}

func textWidth(face font.Face, s string) int {
	return font.MeasureString(face, s).Round()
}

// wrapText greedily wraps s to fit maxW pixels.
func wrapText(s string, face font.Face, maxW int) []string {
	words := strings.Fields(s)
	if len(words) == 0 {
		return []string{""}
	}
	var lines []string
	cur := words[0]
	for _, wd := range words[1:] {
		if textWidth(face, cur+" "+wd) <= maxW {
			cur += " " + wd
		} else {
			lines = append(lines, cur)
			cur = wd
		}
	}
	lines = append(lines, cur)
	return lines
}

func parseHexColor(s string, def color.Color) color.Color {
	s = strings.TrimPrefix(s, "#")
	if len(s) != 6 {
		return def
	}
	var r, g, b int
	_, err := parseHex(s, &r, &g, &b)
	if err != nil {
		return def
	}
	return color.RGBA{uint8(r), uint8(g), uint8(b), 255}
}

func parseHex(s string, r, g, b *int) (int, error) {
	var rr, gg, bb int
	n, err := sscanHex(s, &rr, &gg, &bb)
	*r, *g, *b = rr, gg, bb
	return n, err
}

func sscanHex(s string, r, g, b *int) (int, error) {
	if len(s) != 6 {
		return 0, os.ErrInvalid
	}
	hv := func(sub string) int {
		v := 0
		for _, ch := range sub {
			v *= 16
			switch {
			case ch >= '0' && ch <= '9':
				v += int(ch - '0')
			case ch >= 'a' && ch <= 'f':
				v += int(ch-'a') + 10
			case ch >= 'A' && ch <= 'F':
				v += int(ch-'A') + 10
			}
		}
		return v
	}
	*r, *g, *b = hv(s[0:2]), hv(s[2:4]), hv(s[4:6])
	return 3, nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
