package main

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// skillRef is a resolved, pinned skill.
type skillRef struct {
	Name       string      // declared skill name (frontmatter name)
	Dir        string      // absolute skill directory
	File       string      // absolute path to SKILL.md
	Preamble   string      // optional opener rendered before the skill body
	ExtraFiles []skillFile // companion files inlined after the body
}

// skillFile is one companion file selected for inlining alongside its
// pinned skill's body.
type skillFile struct {
	Rel     string // slash-separated path relative to the skill dir
	Abs     string // absolute path
	Content []byte // file contents, read once at resolve time
}

// skillLocation is one pi skill discovery directory.
type skillLocation struct {
	dir  string
	mode string // "pi" (root .md files count) or "agents" (nested .md files count)
}

// resolveSkillTarget is the name/path resolution core of resolveSkill,
// without preamble handling.
func resolveSkillTarget(cwd, agentDir string, trusted bool, pin string) (skillRef, error) {
	if info, err := os.Stat(pin); err == nil {
		if info.IsDir() {
			return skillRefFromDir(pin)
		}
		if strings.HasSuffix(pin, ".md") {
			return skillRefFromFile(pin)
		}
		return skillRef{}, fmt.Errorf("pin %q is a file but not a markdown skill", pin)
	}

	for _, loc := range skillLocations(cwd, agentDir, trusted) {
		if ref, err := findInLocation(loc, pin); err != nil {
			return skillRef{}, err
		} else if ref != nil {
			return *ref, nil
		}
	}

	return skillRef{}, fmt.Errorf("pinned skill %q not found in any skill location", pin)
}

// skillLocations returns pi's skill discovery directories in pi's own scan
// order (package-manager.js addAutoDiscoveredResources):
//
//  1. <cwd>/.pi/skills            (trusted projects only; cwd-only, pi mode)
//  2. <ancestor>/.agents/skills   cwd up to git root, trusted only, minus
//     $HOME/.agents/skills (agents mode)
//  3. ~/.pi/agent/skills          (pi mode)
//  4. ~/.agents/skills            (agents mode)
func skillLocations(cwd, agentDir string, trusted bool) []skillLocation {
	var locs []skillLocation
	home, _ := os.UserHomeDir()
	userAgents := filepath.Join(home, ".agents", "skills")

	if trusted {
		locs = append(locs, skillLocation{
			dir:  filepath.Join(cwd, ".pi", "skills"),
			mode: "pi",
		})
		root := gitRoot(cwd)
		dir := cwd
		for {
			d := filepath.Join(dir, ".agents", "skills")
			if d != userAgents {
				locs = append(locs, skillLocation{dir: d, mode: "agents"})
			}
			if dir == root || dir == filepath.Dir(dir) {
				break
			}
			dir = filepath.Dir(dir)
		}
	}

	locs = append(locs, skillLocation{dir: filepath.Join(agentDir, "skills"), mode: "pi"})
	locs = append(locs, skillLocation{dir: userAgents, mode: "agents"})
	return locs
}

// findInLocation searches one location for a skill matching pin (by path
// stem or frontmatter name). Returns nil when nothing matches.
func findInLocation(loc skillLocation, pin string) (*skillRef, error) {
	for _, candidate := range walkSkillDir(loc.dir, loc.mode) {
		// Fast path: candidate's own directory (or root-file stem) is the pin.
		if candidateDirName(loc, candidate) == pin {
			return refFromCandidate(candidate)
		}
		// Fallback: match by declared frontmatter name.
		if name, err := skillNameFromFile(candidate); err == nil && name == pin {
			return refFromCandidate(candidate)
		}
	}
	return nil, nil
}

// candidateDirName returns the identifying name for a candidate skill path
// within its location: the containing directory for SKILL.md files, or the
// file stem for root/nested .md skills.
func candidateDirName(loc skillLocation, candidate string) string {
	if filepath.Base(candidate) == "SKILL.md" {
		return filepath.Base(filepath.Dir(candidate))
	}
	// Root .md (pi mode) or nested .md (agents mode).
	rel, err := filepath.Rel(loc.dir, candidate)
	if err != nil {
		return ""
	}
	return strings.TrimSuffix(filepath.Base(rel), ".md")
}

func refFromCandidate(candidate string) (*skillRef, error) {
	name, err := skillNameFromFile(candidate)
	if err != nil {
		return nil, nil
	}
	return &skillRef{Name: name, Dir: filepath.Dir(candidate), File: candidate}, nil
}

// walkSkillDir mirrors pi's collectSkillEntries (package-manager.js):
//   - a directory containing SKILL.md is a skill; do not recurse into it
//   - hidden entries and node_modules are skipped
//   - .md files count as skills at the location root in "pi" mode, and in
//     non-root subdirectories in "agents" mode
//   - otherwise recurse into subdirectories
//
// Missing directories yield an empty result.
func walkSkillDir(dir, mode string) []string {
	return walkSkillDirInternal(dir, mode, dir, 0)
}

func walkSkillDirInternal(dir, mode, root string, depth int) []string {
	var found []string
	if depth > 8 {
		return found
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return found
	}
	// SKILL.md short-circuit: a dir with SKILL.md is a skill; stop.
	for _, e := range entries {
		if e.Name() == "SKILL.md" && isRegularFile(filepath.Join(dir, e.Name())) {
			return []string{filepath.Join(dir, e.Name())}
		}
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") || name == "node_modules" {
			continue
		}
		full := filepath.Join(dir, name)
		if isRegularFile(full) {
			if strings.HasSuffix(name, ".md") {
				atRoot := dir == root
				if (mode == "pi" && atRoot) || (mode == "agents" && !atRoot) {
					found = append(found, full)
				}
			}
			continue
		}
		if isDirectory(full) {
			found = append(found, walkSkillDirInternal(full, mode, root, depth+1)...)
		}
	}
	return found
}

// isRegularFile reports whether path is a regular file, following
// symlinks like pi does (broken symlinks are skipped).
func isRegularFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// skillRefFromDir builds a ref from a skill directory containing SKILL.md.
func skillRefFromDir(dir string) (skillRef, error) {
	skillMD := filepath.Join(dir, "SKILL.md")
	if !fileExists(skillMD) {
		return skillRef{}, fmt.Errorf("skill directory %s has no SKILL.md", dir)
	}
	name, err := skillNameFromFile(skillMD)
	if err != nil {
		return skillRef{}, fmt.Errorf("in %s: %w", dir, err)
	}
	return skillRef{Name: name, Dir: dir, File: skillMD}, nil
}

// skillRefFromFile builds a ref from a standalone .md skill file.
func skillRefFromFile(file string) (skillRef, error) {
	name, err := skillNameFromFile(file)
	if err != nil {
		return skillRef{}, fmt.Errorf("in %s: %w", file, err)
	}
	return skillRef{Name: name, Dir: filepath.Dir(file), File: file}, nil
}

// skillNameFromFile extracts the frontmatter name from a skill markdown
// file. Pi refuses to load skills without frontmatter name+description, so
// errors here mean pi would ignore the file too.
func skillNameFromFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	fm, ok := parseFrontmatter(string(data))
	if !ok {
		return "", errors.New("no skill frontmatter (missing '---' header block)")
	}
	name := strings.TrimSpace(fm["name"])
	if name == "" {
		return "", errors.New("frontmatter has no name")
	}
	return name, nil
}

// parseFrontmatter extracts flat key: value pairs from the leading YAML
// frontmatter block. Multi-line values (folded descriptions) are not
// needed: only the name key matters here.
func parseFrontmatter(text string) (map[string]string, bool) {
	lines := strings.SplitN(text, "\n", 200)
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return nil, false
	}
	fields := map[string]string{}
	for _, line := range lines[1:] {
		if strings.TrimSpace(line) == "---" {
			if len(fields) > 0 {
				return fields, true
			}
			return nil, false
		}
		idx := strings.Index(line, ":")
		if idx < 0 {
			continue
		}
		key := strings.TrimSpace(line[:idx])
		val := strings.Trim(strings.TrimSpace(line[idx+1:]), "\"'")
		if _, exists := fields[key]; !exists {
			fields[key] = val
		}
	}
	return nil, false
}

// listSkills prints every resolvable skill across the discovery locations,
// one per line: "<name>\t<path>".
func listSkills(w *os.File, cwd, agentDir string, trusted bool) error {
	var b strings.Builder
	for _, loc := range skillLocations(cwd, agentDir, trusted) {
		for _, candidate := range walkSkillDir(loc.dir, loc.mode) {
			ref, err := refFromCandidate(candidate)
			if err != nil || ref == nil {
				continue
			}
			fmt.Fprintf(&b, "%s\t%s\n", ref.Name, ref.File)
		}
	}
	fmt.Fprint(w, b.String())
	return nil
}

// isDirectory reports whether path is a directory, following symlinks.
func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// ---------- companion file inlining ----------

// maxInlineFilesBytes caps the total inlined companion-file bytes per
// pinned skill, so a wide glob cannot silently blow up every request's
// system prompt. SKILL.md itself is not counted.
const maxInlineFilesBytes = 256 << 10

// matchRelPath reports whether rel (slash-separated path relative to the
// skill directory) matches a glob pattern. Segments match with
// filepath.Match rules (* and ? stay within one segment); ** matches any
// number of segments, including none.
func matchRelPath(pattern, rel string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(rel, "/"))
}

func matchSegments(pattern, path []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			rest := pattern[1:]
			for i := 0; i <= len(path); i++ {
				if matchSegments(rest, path[i:]) {
					return true
				}
			}
			return false
		}
		if len(path) == 0 {
			return false
		}
		ok, err := filepath.Match(pattern[0], path[0])
		if err != nil || !ok {
			return false
		}
		pattern, path = pattern[1:], path[1:]
	}
	return len(path) == 0
}

// skillDirEntries lists candidate file paths under skillDir as
// slash-separated paths relative to skillDir, in sorted order. Hidden
// entries, node_modules, symlinks, and any SKILL.md (already inlined as
// the skill body) are excluded. maxSkillFileDepth bounds recursion.
func skillDirEntries(skillDir string) []string {
	const maxSkillFileDepth = 10
	var out []string
	var walk func(dir, rel string, depth int)
	walk = func(dir, rel string, depth int) {
		if depth > maxSkillFileDepth {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			name := e.Name()
			if strings.HasPrefix(name, ".") || name == "node_modules" || e.Type()&fs.ModeSymlink != 0 {
				continue
			}
			relPath := name
			if rel != "" {
				relPath = rel + "/" + name
			}
			if e.IsDir() {
				walk(filepath.Join(dir, name), relPath, depth+1)
				continue
			}
			if !e.Type().IsRegular() || name == "SKILL.md" {
				continue
			}
			out = append(out, relPath)
		}
	}
	walk(skillDir, "", 0)
	sort.Strings(out)
	return out
}

// looksBinary reports whether content starts with a NUL byte in its first
// 8 KB — good enough to keep images and other binary blobs out of the
// system prompt.
func looksBinary(content []byte) bool {
	n := len(content)
	if n > 8192 {
		n = 8192
	}
	return bytes.IndexByte(content[:n], 0) >= 0
}

// resolveSkillFiles matches patterns against the skill directory's files
// and returns the files to inline, in pattern order (sorted within each
// pattern), deduplicated. Each unmatched or invalid pattern produces a
// warning. The per-skill byte budget drops the tail, also warned.
func resolveSkillFiles(skillDir string, patterns []string) ([]skillFile, []string) {
	if len(patterns) == 0 {
		return nil, nil
	}
	var files []skillFile
	var warnings []string
	seen := map[string]bool{}
	candidates := skillDirEntries(skillDir)
	for _, pat := range patterns {
		if segs := strings.Split(pat, "/"); len(segs) > 0 && segs[0] != "**" {
			if _, err := filepath.Match(segs[0], ""); err != nil {
				warnings = append(warnings, fmt.Sprintf("invalid file pattern %q: %v", pat, err))
				continue
			}
		}
		matched := 0
		for _, rel := range candidates {
			if seen[rel] || !matchRelPath(pat, rel) {
				continue
			}
			seen[rel] = true
			matched++
			abs := filepath.Join(skillDir, filepath.FromSlash(rel))
			content, err := os.ReadFile(abs)
			if err != nil {
				warnings = append(warnings, fmt.Sprintf("cannot read %s: %v", abs, err))
				continue
			}
			if looksBinary(content) {
				warnings = append(warnings, fmt.Sprintf("skipping %s: looks binary", abs))
				continue
			}
			files = append(files, skillFile{Rel: rel, Abs: abs, Content: content})
		}
		if matched == 0 {
			warnings = append(warnings, fmt.Sprintf("file pattern %q matched no files in %s", pat, skillDir))
		}
	}
	var kept []skillFile
	var total int
	var skipped []string
	for _, f := range files {
		if total+len(f.Content) > maxInlineFilesBytes {
			skipped = append(skipped, f.Rel)
			continue
		}
		total += len(f.Content)
		kept = append(kept, f)
	}
	if len(skipped) > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"inline file budget (%d KB) exceeded for %s; skipped: %s",
			maxInlineFilesBytes/1024, skillDir, strings.Join(skipped, ", ")))
	}
	return kept, warnings
}
