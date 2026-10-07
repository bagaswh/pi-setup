// Command pil is a launcher for the pi coding agent that pins skills into
// the system prompt.
//
// Why a launcher: `pi --skill X` only lists a skill's *description* in
// <available_skills> and relies on the model to load the file when the task
// seems to match (progressive disclosure). Nothing guarantees the model
// ever reads it. pil turns selected skills into standing instructions: it
// resolves each pinned skill name to its SKILL.md across pi's skill
// discovery locations, then appends the full file contents to the system
// prompt via `--append-system-prompt` (pi inlines the value when it is not
// an existing file path). Each pinned skill is also registered with
// `--skill <dir>` so /skill:name commands and the skill tools keep working
// for companion files (scripts/, references/).
//
// Pin sources, merged and de-duplicated by skill name (first wins):
//
//  1. project config: <cwd>/.pi/pil.json (trusted projects only)
//  2. global config: $PI_CODING_AGENT_DIR/pil.json (default ~/.pi/agent/pil.json)
//  3. CLI: --pil-skill <name-or-path> (repeatable)
//
// Any explicit --append-system-prompt disables pi's auto-discovery of
// .pi/APPEND_SYSTEM.md and ~/.pi/agent/APPEND_SYSTEM.md, so when pins are
// active pil re-attaches the discovered file first to keep default
// behavior intact.
//
// Everything else on the command line is forwarded to pi verbatim.
package main

import (
	"fmt"
	"os"
)

const version = "0.2.0"

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintf(os.Stderr, "pil: %v\n", err)
		os.Exit(1)
	}
}

func run(argv []string) error {
	opts, err := parseArgs(argv)
	if err != nil {
		return err
	}
	if opts.help {
		fmt.Fprint(os.Stdout, usageText)
		return nil
	}
	if opts.showVersion {
		fmt.Printf("pil %s\n", version)
		return nil
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("cannot get working directory: %w", err)
	}
	agentDir, err := agentDirPath()
	if err != nil {
		return err
	}
	trusted := projectTrusted(agentDir, cwd)

	if opts.listSkills {
		return listSkills(os.Stdout, cwd, agentDir, trusted)
	}

	pins, warnings := resolvePins(opts, cwd, agentDir, trusted)
	for _, w := range warnings {
		fmt.Fprintf(os.Stderr, "pil: warning: %s\n", w)
	}
	if opts.noPins {
		pins = nil
	}

	args := buildPiArgs(opts.rest, pins, cwd, agentDir, trusted)

	bin, err := piBinary()
	if err != nil {
		return err
	}

	if opts.dryRun {
		printPlan(os.Stdout, bin, args, pins, trusted)
		return nil
	}

	cleanupStaleEnforcement()

	return handoff(bin, args)
}

// resolvePins turns configured pin specs into concrete skillRef values.
//
// Preambles and companion-file patterns attach in this precedence
// (highest first):
//  1. --pil-preamble / --pil-file CLI flags (repeatable)
//  2. pinSpec.Preamble / pinSpec.Files (inline objects in pil.json, or
//     merged config "preambles"/"files" maps — project first, global
//     over it)
//  3. none
//
// Keys may match the configured target OR the resolved skill's declared
// name; the declared-name entry wins (both key styles are accepted).
// Pins that resolve to the same SKILL.md file are deduplicated, keeping
// the first occurrence; a duplicate that carries a missing preamble or
// file patterns donates them to the kept pin.
func resolvePins(opts cliOptions, cwd, agentDir string, trusted bool) ([]skillRef, []string) {
	collected, warnings := collectPinSpecs(opts, cwd, agentDir, trusted)

	var pins []skillRef
	seenTarget := make(map[string]bool)
	seenFile := make(map[string]bool)
	for _, spec := range collected.Specs {
		if seenTarget[spec.Skill] {
			continue
		}
		seenTarget[spec.Skill] = true
		ref, err := resolveSkillTarget(cwd, agentDir, trusted, spec.Skill)
		if err != nil {
			warnings = append(warnings, err.Error())
			continue
		}
		if seenFile[ref.File] {
			// Same skill pinned twice under different targets (e.g. name
			// and path). Keep the first pin; donate anything it lacks.
			for i := range pins {
				if pins[i].File != ref.File {
					continue
				}
				if pins[i].Preamble == "" && spec.Preamble != "" {
					pins[i].Preamble = spec.Preamble
				}
				if len(pins[i].ExtraFiles) == 0 && len(spec.Files) > 0 {
					extra, warns := resolveSkillFiles(ref.Dir, filePatternsFor(spec, ref, collected.Files, opts.files))
					warnings = append(warnings, warns...)
					pins[i].ExtraFiles = extra
				}
			}
			continue
		}
		seenFile[ref.File] = true

		ref.Preamble = preambleFor(spec, ref, collected.Preambles, opts.preambles)
		patterns := filePatternsFor(spec, ref, collected.Files, opts.files)
		extra, warns := resolveSkillFiles(ref.Dir, patterns)
		warnings = append(warnings, warns...)
		ref.ExtraFiles = extra

		pins = append(pins, ref)
	}
	return pins, warnings
}

// preambleFor resolves one pin's preamble: CLI flag beats the inline
// spec preamble beats the config map; declared-name keys beat target
// keys at the same level.
func preambleFor(spec pinSpec, ref skillRef, cfgPreambles, cliPreambles map[string]string) string {
	preamble := cfgPreambles[spec.Skill]
	if named, ok := cfgPreambles[ref.Name]; ok {
		preamble = named
	}
	if spec.Preamble != "" {
		preamble = spec.Preamble
	}
	if text, ok := cliPreambles[ref.Name]; ok {
		preamble = text
	}
	if text, ok := cliPreambles[spec.Skill]; ok {
		preamble = text
	}
	return preamble
}

// filePatternsFor resolves one pin's companion-file glob patterns with
// the same precedence as preambles.
func filePatternsFor(spec pinSpec, ref skillRef, cfgFiles, cliFiles map[string][]string) []string {
	if p := cliFiles[ref.Name]; len(p) > 0 {
		return p
	}
	if p := cliFiles[spec.Skill]; len(p) > 0 {
		return p
	}
	if len(spec.Files) > 0 {
		return spec.Files
	}
	if p := cfgFiles[ref.Name]; len(p) > 0 {
		return p
	}
	if p := cfgFiles[spec.Skill]; len(p) > 0 {
		return p
	}
	return nil
}

const usageText = `pil - launch pi with pinned skills always in the system prompt

Usage:
  pil [pil-flags] [pi arguments...]

pil-flags (consumed by pil, never forwarded to pi):
  --pil-skill <name>       Pin a skill for this run (repeatable; name or path)
  --pil-preamble <n>=<t>   Preamble opener for a pinned skill (repeatable);
                           overrides any preamble from pil.json
  --pil-file <skill>=<glob>  Inline companion files into the pinned skill
                           block (repeatable; e.g. "asd-ste100=references/*.md",
                           "x=examples/**"). Overrides pil.json files.
  --pil-config <path>      Use this pin config instead of discovered pil.json
  --pil-no-pins            Launch without any pinned skills
  --pil-list-skills        List resolvable skills and exit
  --pil-dry-run            Print the launch plan and exit
  --pil-version            Print the pil version and exit
  --pil-help, -h           Show this help and exit

All other arguments are forwarded to pi verbatim, including '--'.

Pin configuration (JSON with a "skills" array; each entry is a skill
name or an object {"skill": "…", "preamble": "…"}). Preambles are optional
openers rendered inside the pinned skill's block, e.g. "When
communicating, always follow this rule:":
  project:  <cwd>/.pi/pil.json; ignored when the project is not trusted
            in pi's trust.json (same gate pi applies to .pi/skills)
  global:   $PI_CODING_AGENT_DIR/pil.json (default ~/.pi/agent/pil.json)

Alternatively keep "skills" as plain strings and set a separate
"preambles" map of skill name to text:

Example ~/.pi/agent/pil.json:
  {
    "skills": ["asd-ste100"],
    "preambles": {"asd-ste100": "When communicating, always follow this rule:"}
  }

Equivalent inline form:
  {
    "skills": [{"skill": "asd-ste100",
                "preamble": "When communicating, always follow this rule:"}]
  }

Preamble precedence: --pil-preamble beats inline objects beats the
"preambles" map.

Companion files: by default only SKILL.md is inlined. Glob patterns
(relative to the skill directory) inline more, each in its own
<skill_file path="…"> block after the skill body:

  "files": {"asd-ste100": ["references/*.md", "examples/**"]}

or inline per pin: {"skill": "asd-ste100", "files": ["references/*"]},
or per run: --pil-file "asd-ste100=references/*.md" (same precedence
rules as preambles). Patterns support ** across directories. Hidden
entries, node_modules, symlinks, and binary files never match; a 256 KB
per-skill budget drops the overflow with a warning, and unmatched
patterns warn every launch.

Skill name resolution mirrors pi's discovery locations, in this order:
  1. <cwd>/.pi/skills/<name>/              (trusted projects only)
  2. <ancestor>/.agents/skills/<name>/     up to the git root (trusted only)
  3. ~/.agents/skills/<name>/
  4. $PI_CODING_AGENT_DIR/skills/<name>/
A value that is an existing file or directory is used as-is. Otherwise, if
no <location>/<name>/SKILL.md exists, skill directories are scanned and
matched by the name declared in their SKILL.md frontmatter.
`
