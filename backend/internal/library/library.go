// Package library indexes clips produced by the sibling products so any of them
// can be pulled into a Studio project. It scans each product's known output dir
// plus a global "inbox" that the /api/ingest endpoint (the universal
// "Send to Studio" target) writes into.
package library

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Source is one scanned directory.
type Source struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Dir  string `json:"dir"`
}

// Entry is a discovered clip.
type Entry struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Source  string `json:"source"`
	Path    string `json:"path"`
	Ext     string `json:"ext"`
	Size    int64  `json:"size"`
	ModTime string `json:"modTime"`
}

// Scanner discovers clips across the configured sources.
type Scanner struct {
	sources []Source
	allowed []string // absolute source dirs, for import path validation
}

var videoExt = map[string]bool{
	".mp4": true, ".mov": true, ".webm": true, ".m4v": true, ".gif": true, ".mkv": true,
}

// candidate describes a potential source relative to the studio root.
type candidate struct{ id, name, rel string }

var candidates = []candidate{
	{"newaniadv", "newaniAdv renders", "../newaniAdv/renders"},
	{"newaniadv-root", "newaniAdv (root)", "../newaniAdv"},
	{"hyperframes", "HyperFrames renders", "../hyper/hyperframes/renders"},
	{"hyper-app", "Codigo renders", "../hyper/app/.data/renders"},
	{"hyper-templates", "Codigo template previews", "../hyper/app/public/template-previews"},
	{"funkycode", "FunkyCode public", "../funkycode/public"},
}

// New builds a scanner for the given studio root and inbox dir. Missing
// directories are skipped so it works regardless of which products are present.
func New(studioRoot, inboxDir string) *Scanner {
	s := &Scanner{}
	add := func(id, name, dir string) {
		abs, err := filepath.Abs(dir)
		if err != nil {
			return
		}
		if fi, err := os.Stat(abs); err != nil || !fi.IsDir() {
			return
		}
		s.sources = append(s.sources, Source{ID: id, Name: name, Dir: abs})
		s.allowed = append(s.allowed, abs)
	}
	_ = os.MkdirAll(inboxDir, 0o755) // always present so ingested clips are indexed
	add("inbox", "Inbox (Send to Studio)", inboxDir)
	for _, c := range candidates {
		add(c.id, c.name, filepath.Join(studioRoot, c.rel))
	}
	return s
}

// Sources returns the active source directories.
func (s *Scanner) Sources() []Source { return s.sources }

// Scan walks all sources (shallow, depth<=2) and returns clips newest-first.
func (s *Scanner) Scan(limit int) []Entry {
	var out []Entry
	for _, src := range s.sources {
		root := src.Dir
		_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				// limit depth to 2 below the source and skip node_modules
				rel, _ := filepath.Rel(root, p)
				if strings.Contains(rel, "node_modules") {
					return filepath.SkipDir
				}
				if strings.Count(rel, string(os.PathSeparator)) >= 2 && rel != "." {
					return filepath.SkipDir
				}
				return nil
			}
			ext := strings.ToLower(filepath.Ext(p))
			if !videoExt[ext] {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return nil
			}
			out = append(out, Entry{
				ID:      hashPath(p),
				Name:    filepath.Base(p),
				Source:  src.ID,
				Path:    p,
				Ext:     ext,
				Size:    info.Size(),
				ModTime: info.ModTime().UTC().Format(time.RFC3339),
			})
			return nil
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ModTime > out[j].ModTime })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Allowed reports whether p sits inside one of the scanned source dirs. Guards
// the import endpoint against arbitrary filesystem reads.
func (s *Scanner) Allowed(p string) bool {
	abs, err := filepath.Abs(p)
	if err != nil {
		return false
	}
	for _, dir := range s.allowed {
		if rel, err := filepath.Rel(dir, abs); err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}

func hashPath(p string) string {
	h := sha1.Sum([]byte(p))
	return "lib_" + hex.EncodeToString(h[:6])
}
