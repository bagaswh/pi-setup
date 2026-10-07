package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// printPlan writes the dry-run launch plan: the exec target, the flags pil
// contributes, the forwarded user args, and the effective system-prompt
// pin block (intro + each pinned skill's first lines) so the user can see
// exactly what the model will receive.
func printPlan(w *os.File, bin string, args []string, pins []skillRef, trusted bool) {
	fmt.Fprintf(w, "exec: %s\n", bin)
	fmt.Fprintf(w, "project-trusted: %v\n", trusted)
	if len(pins) == 0 {
		fmt.Fprintln(w, "pins: (none)")
	} else {
		fmt.Fprintf(w, "pins (%d):\n", len(pins))
		for _, pin := range pins {
			fmt.Fprintf(w, "  %s -> %s\n", pin.Name, pin.File)
			if pin.Preamble != "" {
				fmt.Fprintf(w, "    preamble: %q\n", pin.Preamble)
			}
			if len(pin.ExtraFiles) > 0 {
				fmt.Fprintf(w, "    files: %s\n", summarizeRelPaths(pin.ExtraFiles, 4))
			}
		}
	}
	sep := strings.Repeat("-", 60)
	fmt.Fprintln(w, sep)
	fmt.Fprintln(w, "pi argv:")
	for _, a := range args {
		fmt.Fprintf(w, "  %q\n", a)
	}
}

// summarizeRelPaths renders up to max file paths, comma-separated, with a
// "+N more" suffix when truncated.
func summarizeRelPaths(files []skillFile, max int) string {
	rels := make([]string, 0, len(files))
	for _, f := range files {
		rels = append(rels, f.Rel)
	}
	if len(rels) > max {
		return fmt.Sprintf("%s (+%d more)", strings.Join(rels[:max], ", "), len(rels)-max)
	}
	return strings.Join(rels, ", ")
}

// cleanupStaleEnforcement removes pil-forced-*.md temp files older than one
// hour from the system temp dir. Normally the file is consumed by pi at
// startup and lingers harmlessly; this keeps /tmp from accumulating. Runs
// before exec at startup, best-effort with no failure path.
func cleanupStaleEnforcement() {
	tmpDir := os.TempDir()
	entries, err := os.ReadDir(tmpDir)
	if err != nil {
		return
	}
	cutoff := time.Now().Add(-time.Hour)
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasPrefix(name, "pil-forced-") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(tmpDir, name))
		}
	}
}
