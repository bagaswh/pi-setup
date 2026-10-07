package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// agentDirPath returns pi's agent config dir: $PI_CODING_AGENT_DIR or
// ~/.pi/agent (pi's documented default).
func agentDirPath() (string, error) {
	if dir := os.Getenv("PI_CODING_AGENT_DIR"); dir != "" {
		return filepath.Abs(dir)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot determine home directory: %w", err)
	}
	return filepath.Join(home, ".pi", "agent"), nil
}

// pinSpec is one configured pin. In pil.json the "skills" array accepts
// two entry forms:
//
//	"skill-name"                            plain string
//	{"skill": "name", "preamble": "…"}      object with optional preamble
//
// Preamble is an optional opener rendered inside the <forced_skill> block
// before the skill body, telling the model how to apply the skill, e.g.
// "When communicating, always follow this rule:".
//
// Files lists glob patterns (relative to the skill directory) for
// companion files to inline after the skill body, e.g.
// ["references/*.md", "examples/**"].
type pinSpec struct {
	Skill    string   `json:"skill"`
	Preamble string   `json:"preamble"`
	Files    []string `json:"files"`
}

// pilConfig is the pin configuration file format (pil.json).
//
// "preambles" is an alternative to inline objects: a map of skill name to
// preamble text, and "files" a map of skill name to glob patterns for
// companion files to inline — alternatives to inline objects, for configs
// that keep "skills" as plain strings.
type pilConfig struct {
	Skills    []pinSpec           `json:"skills"`
	Preambles map[string]string   `json:"preambles"`
	Files     map[string][]string `json:"files"`
}

// UnmarshalJSON lets pinSpec accept both plain strings and objects, so
// {"skills": ["a", {"skill": "b", "preamble": "…"}]} parses.
func (p *pinSpec) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		p.Skill = s
		return nil
	}
	type rawPin pinSpec // shadow type avoids recursion
	var r rawPin
	if err := json.Unmarshal(data, &r); err != nil {
		return fmt.Errorf("invalid pin entry: want a skill name string or an object with skill/preamble fields")
	}
	*p = pinSpec(r)
	return nil
}

// collectedPins is what collectPinSpecs gathers: pin specs plus the
// merged config-level preamble and file-pattern maps.
type collectedPins struct {
	Specs     []pinSpec
	Preambles map[string]string
	Files     map[string][]string
}

// collectPinSpecs gathers pin specs from all sources in priority order:
// project pil.json (trusted projects only), global pil.json, then
// --pil-skill flags. Duplicates by target keep the first occurrence.
// Inline preambles and file patterns ride along on their spec.
//
// It also returns the merged config "preambles" and "files" maps
// (project loaded first, global overriding) for resolvePins.
func collectPinSpecs(opts cliOptions, cwd, agentDir string, trusted bool) (collectedPins, []string) {
	var collected collectedPins
	collected.Preambles = map[string]string{}
	collected.Files = map[string][]string{}
	var warnings []string
	seen := map[string]bool{}

	add := func(spec pinSpec) {
		target := strings.TrimSpace(spec.Skill)
		if target == "" || seen[target] {
			return
		}
		seen[target] = true
		spec.Skill = target
		collected.Specs = append(collected.Specs, spec)
	}

	mergeFile := func(path string) {
		cfg, err := loadPilConfig(path)
		if err != nil {
			warnings = append(warnings, err.Error())
			return
		}
		for _, spec := range cfg.Skills {
			add(spec)
		}
		for name, text := range cfg.Preambles {
			collected.Preambles[name] = text
		}
		for name, patterns := range cfg.Files {
			collected.Files[name] = patterns
		}
	}

	if opts.configPath != "" {
		// --pil-config replaces discovery entirely.
		mergeFile(opts.configPath)
	} else {
		// Project config: cwd-only, like pi's project .pi/ resources.
		if trusted {
			if p := findProjectPilConfig(cwd); p != "" {
				mergeFile(p)
			}
		}
		// Global config.
		mergeFile(filepath.Join(agentDir, "pil.json"))
	}

	// CLI pins merge last.
	for _, name := range opts.pilSkills {
		add(pinSpec{Skill: name})
	}

	return collected, warnings
}

// loadPilConfig reads a pil.json file. A missing file yields an empty
// config (not an error); unreadable or malformed files are.
func loadPilConfig(path string) (pilConfig, error) {
	var cfg pilConfig
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, fmt.Errorf("cannot read pin config %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("invalid pin config %s: %w", path, err)
	}
	return cfg, nil
}

// findProjectPilConfig returns <cwd>/.pi/pil.json when present. Discovery
// is cwd-only, mirroring pi's treatment of project .pi/ resources (only
// .agents/skills walks ancestors).
func findProjectPilConfig(cwd string) string {
	path := filepath.Join(cwd, ".pi", "pil.json")
	if fileExists(path) {
		return path
	}
	return ""
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}

func pathExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// gitRoot returns the git repository root for dir, or dir's filesystem
// root when the path is not inside a repository. This bounds ancestor
// discovery exactly like pi's findGitRepoRoot. Both .git as a directory
// (normal clone) and as a file (worktree/submodule) count.
func gitRoot(dir string) string {
	dir = filepath.Clean(dir)
	for {
		if pathExists(filepath.Join(dir, ".git")) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return dir
		}
		dir = parent
	}
}
