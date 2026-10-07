package main

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// projectTrusted reports whether pi considers cwd a trusted project, by
// reading pi's trust store the same way pi does: nearest-entry-wins lookup
// walking from cwd to the filesystem root (findNearestTrustEntry in
// core/trust-manager.js).
func projectTrusted(agentDir, cwd string) bool {
	trustPath := filepath.Join(agentDir, "trust.json")
	data, err := os.ReadFile(trustPath)
	if err != nil {
		return false
	}
	var store map[string]bool
	if err := json.Unmarshal(data, &store); err != nil {
		return false
	}
	abs := canonicalizePath(cwd)
	for {
		if v, ok := store[abs]; ok {
			return v
		}
		parent := filepath.Dir(abs)
		if parent == abs {
			return false
		}
		abs = parent
	}
}

// canonicalizePath mirrors pi's realpathSync-with-fallback: resolve
// symlinks when possible, otherwise keep the cleaned absolute path.
func canonicalizePath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}
