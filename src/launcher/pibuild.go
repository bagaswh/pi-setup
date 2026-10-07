package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// enforcementIntro is prepended so the model treats pinned skill content as
// binding standing instructions rather than optional reference material it
// may load when a trigger phrase appears.
const enforcementIntro = `MANDATORY ALWAYS-ON SKILLS

The skill instructions between <forced_skill> markers below are pinned by
the user and apply to EVERY message of this session. They are standing
instructions, not on-demand reference material. Do not wait for a trigger
phrase to apply them. Apply them to every response unless they directly
conflict with a tool schema, a system limitation, or an explicit user
instruction in the current conversation.`

// buildPiArgs assembles the final pi argument list:
//
//	[pil-managed flags] + [user args forwarded verbatim]
//
// pil-managed flags, in order:
//  1. --append-system-prompt for each discovered APPEND_SYSTEM.md
//     (any explicit --append-system-prompt disables pi's auto-discovery
//     of .pi/APPEND_SYSTEM.md and ~/.pi/agent/APPEND_SYSTEM.md, so pil
//     re-attaches them to keep default behavior intact)
//  2. per pin: --skill <dir> so /skill:name commands and the skill tools
//     keep working with companion files (scripts/, references/)
//  3. --append-system-prompt <temp file> holding the enforcement wrapper:
//     intro + each pinned skill's body (frontmatter stripped)
//
// With no pins, pil passes user args through untouched, leaving pi's own
// APPEND_SYSTEM.md auto-discovery working as usual.
//
// pil-managed flags come first, so a user who repeats the same flag later
// still controls the final order (pi joins repeated appends with \n\n in
// CLI order).
func buildPiArgs(userArgs []string, pins []skillRef, cwd, agentDir string, trusted bool) []string {
	if len(pins) == 0 {
		return userArgs
	}

	var managed []string

	for _, f := range discoveredAppendFiles(cwd, agentDir, trusted) {
		managed = append(managed, "--append-system-prompt", f)
	}

	for _, pin := range pins {
		managed = append(managed, "--skill", pin.Dir)
	}

	if tmp, err := writeEnforcementFile(pins); err == nil {
		managed = append(managed, "--append-system-prompt", tmp)
	} else {
		// Fallback: append the raw skill files individually so the pins
		// remain in effect even without the wrapper.
		fmt.Fprintf(os.Stderr, "pil: warning: %v; falling back to raw skill files\n", err)
		for _, pin := range pins {
			managed = append(managed, "--append-system-prompt", pin.File)
		}
	}

	return append(managed, userArgs...)
}

// discoveredAppendFiles lists APPEND_SYSTEM.md files pi would have
// auto-discovered for this launch, in pi's order (project then global).
// The project file requires a trusted project, mirroring
// discoverAppendSystemPromptFile in core/resource-loader.js.
func discoveredAppendFiles(cwd, agentDir string, trusted bool) []string {
	var files []string
	if trusted {
		projectPath := filepath.Join(cwd, ".pi", "APPEND_SYSTEM.md")
		if fileExists(projectPath) {
			files = append(files, projectPath)
		}
	}
	globalPath := filepath.Join(agentDir, "APPEND_SYSTEM.md")
	if fileExists(globalPath) {
		files = append(files, globalPath)
	}
	return files
}

// writeEnforcementFile writes the enforcement preamble plus all pinned
// skill bodies (frontmatter stripped) wrapped in <forced_skill> tags, and
// returns the temp file path. Pi reads the file contents at startup when a
// --append-system-prompt value names an existing file. Stale files are
// cleaned up on later runs (cleanupStaleEnforcement).
//
// Each pin's optional Preamble is rendered as a <preamble> element inside
// its <forced_skill> block, directly before the skill body — the opener
// line telling the model how to apply the skill (e.g. "When communicating,
// always follow this rule:"). Preamble text is XML-escaped and wrapped in
// tags so it cannot be confused with the skill body itself.
//
// Companion files (pin.ExtraFiles) render after the skill body, each in
// its own <skill_file path="…"> block labeled with the path relative to
// the skill directory.
func writeEnforcementFile(pins []skillRef) (string, error) {
	var b strings.Builder
	b.WriteString(enforcementIntro)
	for _, pin := range pins {
		content, err := os.ReadFile(pin.File)
		if err != nil {
			return "", fmt.Errorf("cannot read pinned skill %s: %w", pin.File, err)
		}
		b.WriteString("\n\n<forced_skill name=\"")
		b.WriteString(xmlEscape(pin.Name))
		b.WriteString("\" source=\"")
		b.WriteString(xmlEscape(pin.File))
		b.WriteString("\">\n")
		if pin.Preamble != "" {
			b.WriteString("<preamble>\n")
			b.WriteString(xmlEscape(pin.Preamble))
			b.WriteString("\n</preamble>\n")
		}
		b.Write(stripFrontmatter(content))
		for _, ef := range pin.ExtraFiles {
			b.WriteString("\n\n<skill_file path=\"")
			b.WriteString(xmlEscape(ef.Rel))
			b.WriteString("\">\n")
			b.Write(stripFrontmatter(ef.Content))
			b.WriteString("\n</skill_file>")
		}
		b.WriteString("\n</forced_skill>")
	}
	tmp, err := os.CreateTemp("", "pil-forced-*.md")
	if err != nil {
		return "", err
	}
	if _, err := tmp.WriteString(b.String()); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return "", err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return "", err
	}
	return tmp.Name(), nil
}

// stripFrontmatter removes a leading YAML frontmatter block (--- ... ---)
// from skill content; the block is catalog metadata, not instructions, so
// it would only add noise inside the system prompt.
func stripFrontmatter(content []byte) []byte {
	s := string(content)
	if !strings.HasPrefix(s, "---") {
		return content
	}
	lines := strings.SplitN(s, "\n", 500)
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			rest := strings.Join(lines[i+1:], "\n")
			return []byte(strings.TrimLeft(rest, "\n"))
		}
	}
	return content
}

func xmlEscape(s string) string {
	r := strings.NewReplacer(
		"&", "&amp;",
		"<", "&lt;",
		">", "&gt;",
		`"`, "&quot;",
		"'", "&apos;",
	)
	return r.Replace(s)
}

// execLookPath is a thin seam for tests.
var execLookPath = exec.LookPath

// piBinary locates the pi executable: $PI_BIN when set, else PATH lookup,
// else the known install path on this machine.
func piBinary() (string, error) {
	if bin := os.Getenv("PI_BIN"); bin != "" {
		return bin, nil
	}
	if bin, err := execLookPath("pi"); err == nil {
		return bin, nil
	}
	// Known install location for this environment (node-managed install).
	fallback := "/home/bagaswh/.local/share/pi-node/node-v22.23.2-linux-x64/bin/pi"
	if fileExists(fallback) {
		return fallback, nil
	}
	return "", fmt.Errorf("pi executable not found: set PI_BIN or add pi to PATH")
}
