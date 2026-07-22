package httpapi

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"studio/internal/schema"
)

// Provenance is how a clip authored outside Studio arrives still editable.
//
// Clips made in a plugin's own UI used to import as dead media: Studio received
// a finished file and never saw the document that produced it, so the clip could
// be placed on the timeline but never adjusted again. The only way back was to
// leave Studio, redo the edit in the plugin, and re-import.
//
// The fix is a sidecar written next to the media, rather than a live channel
// back into the plugin's page. A sidecar costs a plugin about five lines, needs
// no handshake, no shared origin and no protocol version, and works for every
// path a file can arrive by — the watch folders, the inbox, "Send to Studio",
// and a plugin's own UI alike. A postMessage bridge would have bought the same
// thing at the price of a bidirectional contract in every plugin repo.
type Provenance struct {
	// GeneratorID must match a generator Studio knows, since re-rendering means
	// running it again.
	GeneratorID string            `json:"generatorId"`
	Input       string            `json:"input"`
	Params      map[string]string `json:"params,omitempty"`
}

// provenanceSuffix is appended to the media filename: clip.mp4 → clip.studio.json.
const provenanceSuffix = ".studio.json"

// maxProvenanceBytes caps a sidecar. Input documents are text; anything larger
// is a mistake, and reading it into memory on every import would be one too.
const maxProvenanceBytes = 4 << 20

// provenancePath returns the sidecar path for a media file.
func provenancePath(mediaPath string) string {
	return strings.TrimSuffix(mediaPath, filepath.Ext(mediaPath)) + provenanceSuffix
}

// readProvenance loads the sidecar beside a media file, if there is one. A
// missing sidecar is not an error — most files simply don't have one, and the
// clip imports as before.
func readProvenance(mediaPath string) (*Provenance, error) {
	path := provenancePath(mediaPath)
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil // no sidecar
	}
	if info.Size() > maxProvenanceBytes {
		return nil, fmt.Errorf("%s is %d bytes, over the %d limit", filepath.Base(path), info.Size(), maxProvenanceBytes)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var p Provenance
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, fmt.Errorf("%s: %w", filepath.Base(path), err)
	}
	if p.GeneratorID == "" {
		return nil, fmt.Errorf("%s: missing generatorId", filepath.Base(path))
	}
	return &p, nil
}

// applyProvenance marks an asset as re-renderable by the generator that made it.
//
// It refuses a generator Studio doesn't have: Source doubles as the generator id
// for generated assets, so trusting an unknown one would produce a clip that
// looks editable and fails when someone tries. Better to import it as plain
// media and say so.
func (s *Server) applyProvenance(asset *schema.Asset, p *Provenance) error {
	if p == nil {
		return nil
	}
	if _, ok := s.Gens.Get(p.GeneratorID); !ok {
		return fmt.Errorf("unknown generator %q", p.GeneratorID)
	}
	asset.Source = p.GeneratorID
	asset.GenInput = p.Input
	asset.GenParams = p.Params
	return nil
}

// adoptProvenance attaches a sidecar found next to srcPath, and reports why it
// couldn't when there was one. The import itself never fails over provenance:
// the media is good either way, and losing the clip because its metadata was
// malformed would be a worse outcome than losing its editability.
func (s *Server) adoptProvenance(asset *schema.Asset, srcPath string) string {
	p, err := readProvenance(srcPath)
	if err != nil {
		return err.Error()
	}
	if p == nil {
		return ""
	}
	if err := s.applyProvenance(asset, p); err != nil {
		return err.Error()
	}
	return ""
}
