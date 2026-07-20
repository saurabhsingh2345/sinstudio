package httpapi

import (
	"context"
	"fmt"
	"os"
	"sync"

	"studio/internal/media"
)

// probeCacheCap bounds the cache so a long-running server doesn't leak memory.
const probeCacheCap = 512

var (
	probeMu    sync.Mutex
	probeCache = map[string]media.Info{} // key(path+mtime+size) -> probed info
	probeOrder []string                  // insertion order for FIFO eviction
)

// probeKey identifies a file by path + mtime + size so a regenerated asset (same
// path, new content) misses the cache instead of serving stale metadata. Same
// scheme as waveKey.
func probeKey(path string) string {
	if fi, err := os.Stat(path); err == nil {
		return fmt.Sprintf("%s|%d|%d", path, fi.ModTime().UnixNano(), fi.Size())
	}
	return path
}

// probeCached runs media.Probe once per distinct file version. GET /api/projects
// backfills hasAudio for assets that predate the field, which means an ffprobe
// per asset on every load until the client saves the doc back — with several
// editors polling the same project that adds up to a lot of redundant processes.
func probeCached(ctx context.Context, path string) (media.Info, error) {
	key := probeKey(path)
	probeMu.Lock()
	info, ok := probeCache[key]
	probeMu.Unlock()
	if ok {
		return info, nil
	}

	// Cache by value, not by the returned pointer, so a caller can't mutate the
	// shared entry.
	probed, err := media.Probe(ctx, path)
	if err != nil {
		return media.Info{}, err
	}
	info = *probed

	probeMu.Lock()
	defer probeMu.Unlock()
	if _, exists := probeCache[key]; !exists {
		probeOrder = append(probeOrder, key)
		for len(probeOrder) > probeCacheCap {
			delete(probeCache, probeOrder[0])
			probeOrder = probeOrder[1:]
		}
	}
	probeCache[key] = info
	return info, nil
}
