package main

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// ---------- helpers ----------

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	writeFileRaw(t, path, []byte(content))
}

func writeFileRaw(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

const skillMD = `---
name: %s
description: A test skill.
---

# Test

Body.
`

func makeSkillDir(t *testing.T, dir, name string) string {
	t.Helper()
	writeFile(t, filepath.Join(dir, name, "SKILL.md"), fmt.Sprintf(skillMD, name))
	return filepath.Join(dir, name)
}

// ---------- cli ----------

func TestParseArgs(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		rest []string
		skip int // count of pilSkills
	}{
		{"plain prompt", []string{"hello"}, []string{"hello"}, 0},
		{"pil flag consumed", []string{"--pil-skill", "a", "-p", "hi"}, []string{"-p", "hi"}, 1},
		{"dashdash forwarded", []string{"-p", "--", "-x", "y"}, []string{"-p", "--", "-x", "y"}, 0},
		{"unknown flags kept", []string{"--skill", "x", "--append-system-prompt", "y"}, []string{"--skill", "x", "--append-system-prompt", "y"}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			opts, err := parseArgs(tt.argv)
			if err != nil {
				t.Fatalf("parseArgs error: %v", err)
			}
			if !reflect.DeepEqual(opts.rest, tt.rest) {
				t.Errorf("rest = %v, want %v", opts.rest, tt.rest)
			}
			if len(opts.pilSkills) != tt.skip {
				t.Errorf("pilSkills = %v, want len %d", opts.pilSkills, tt.skip)
			}
		})
	}

	if _, err := parseArgs([]string{"--pil-skill"}); err == nil {
		t.Error("missing value should error")
	}
}

func TestParseArgsDashDashStopsPilFlags(t *testing.T) {
	opts, err := parseArgs([]string{"--", "--pil-no-pins"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.noPins {
		t.Error("flag after -- must be forwarded, not consumed")
	}
	if !reflect.DeepEqual(opts.rest, []string{"--", "--pil-no-pins"}) {
		t.Errorf("rest = %v", opts.rest)
	}
}

// ---------- frontmatter ----------

func TestParseFrontmatter(t *testing.T) {
	text := "---\nname: my-skill\ndescription: \"Multi word\"\n---\nbody\n"
	fm, ok := parseFrontmatter(text)
	if !ok || fm["name"] != "my-skill" {
		t.Fatalf("got %v ok=%v", fm, ok)
	}
	if _, ok := parseFrontmatter("no frontmatter here"); ok {
		t.Error("expected failure without --- header")
	}
	// Unterminated frontmatter (no closing ---) must fail.
	if _, ok := parseFrontmatter("---\nname: x\n"); ok {
		t.Error("expected failure without closing ---")
	}
	// Fields before a closing --- with zero captured fields still parse.
	if fm, ok := parseFrontmatter("---\nkey: val\n---\n"); !ok || fm["key"] != "val" {
		t.Errorf("got %v ok=%v", fm, ok)
	}
}

func TestSkillNameFromFile(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "SKILL.md")
	writeFile(t, p, "---\nname: alpha\ndescription: d\n---\n")
	if name, err := skillNameFromFile(p); err != nil || name != "alpha" {
		t.Fatalf("got %q err %v", name, err)
	}
	writeFile(t, p, "---\ndescription: d\n---\n")
	if _, err := skillNameFromFile(p); err == nil {
		t.Error("missing name must error")
	}
}

// ---------- skill walking ----------

func TestWalkSkillDir(t *testing.T) {
	root := t.TempDir()
	// pi-mode root .md counts; agents-mode root .md does not.
	writeFile(t, filepath.Join(root, "loose.md"), "---\nname: loose\ndescription: d\n---\n")
	// SKILL.md short-circuit: dir with SKILL.md, plus decoy nested files.
	makeSkillDir(t, root, "withskill")
	writeFile(t, filepath.Join(root, "withskill", "nested", "extra.md"), "---\nname: extra\ndescription: d\n---\n")
	// Plain dir recursed in agents mode: nested .md counts.
	writeFile(t, filepath.Join(root, "group", "one.md"), "---\nname: one\ndescription: d\n---\n")
	// Hidden and node_modules skipped.
	writeFile(t, filepath.Join(root, ".hidden", "h.md"), "---\nname: h\ndescription: d\n---\n")
	writeFile(t, filepath.Join(root, "node_modules", "n.md"), "---\nname: n\ndescription: d\n---\n")

	gotPi := walkSkillDir(root, "pi")
	// pi mode: root .md counts; nested .md in plain dirs does NOT count
	// (that is agents-mode only); SKILL.md short-circuits its directory.
	wantPi := map[string]bool{
		filepath.Join(root, "loose.md"):              true,
		filepath.Join(root, "withskill", "SKILL.md"): true,
	}
	if len(gotPi) != len(wantPi) {
		t.Fatalf("pi mode: got %v", gotPi)
	}
	for _, p := range gotPi {
		if !wantPi[p] {
			t.Errorf("pi mode unexpected %s", p)
		}
	}

	gotAgents := walkSkillDir(root, "agents")
	foundNested := false
	for _, p := range gotAgents {
		if strings.HasSuffix(p, "loose.md") {
			t.Errorf("agents mode must not include root .md: %v", gotAgents)
		}
		if strings.HasSuffix(p, filepath.Join("group", "one.md")) {
			foundNested = true
		}
	}
	if !foundNested {
		t.Errorf("agents mode must include group/one.md: %v", gotAgents)
	}
	// SKILL.md short-circuit: withskill/nested/extra.md must not appear.
	for _, p := range gotPi {
		if strings.Contains(p, "nested") {
			t.Error("must not recurse into a skill dir containing SKILL.md")
		}
	}
}

// ---------- resolution ----------

func TestResolveSkillByNameAndPath(t *testing.T) {
	tmp := t.TempDir()
	projSkills := filepath.Join(tmp, "proj", ".pi", "skills")
	userAgents := filepath.Join(tmp, "home", ".agents", "skills")
	agentSkills := filepath.Join(tmp, "agentdir", "skills")

	makeSkillDir(t, projSkills, "proj-skill")
	makeSkillDir(t, userAgents, "user-skill")
	makeSkillDir(t, agentSkills, "agent-skill")
	// Declared name differs from dir name (pi allows this).
	writeFile(t, filepath.Join(userAgents, "weird-dir", "SKILL.md"), "---\nname: declared-name\ndescription: d\n---\n")

	cwd := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(tmp, "home"))

	cases := []struct {
		pin  string
		want string
	}{
		{"proj-skill", "proj-skill"},
		{"user-skill", "user-skill"},
		{"agent-skill", "agent-skill"},
		{"declared-name", "declared-name"},                      // frontmatter fallback
		{filepath.Join(projSkills, "proj-skill"), "proj-skill"}, // explicit path
	}
	for _, c := range cases {
		ref, err := resolveSkillTarget(cwd, filepath.Join(tmp, "agentdir"), true, c.pin)
		if err != nil {
			t.Fatalf("resolveSkill(%q): %v", c.pin, err)
		}
		if ref.Name != c.want {
			t.Errorf("resolveSkill(%q) = %q, want %q", c.pin, ref.Name, c.want)
		}
	}

	if _, err := resolveSkillTarget(cwd, tmp, true, "nope"); err == nil {
		t.Error("missing skill must error")
	}
}

func TestResolveSkillUntrustedDropsProjectLocations(t *testing.T) {
	tmp := t.TempDir()
	projSkills := filepath.Join(tmp, "proj", ".pi", "skills")
	makeSkillDir(t, projSkills, "proj-skill")
	cwd := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(tmp, "home"))

	if _, err := resolveSkillTarget(cwd, tmp, false, "proj-skill"); err == nil {
		t.Error("untrusted project skill must not resolve")
	}
	if _, err := resolveSkillTarget(cwd, tmp, true, "proj-skill"); err != nil {
		t.Errorf("trusted project skill must resolve: %v", err)
	}
}

func TestSkillLocationsOrder(t *testing.T) {
	tmp := t.TempDir()
	cwd := filepath.Join(tmp, "proj", "sub")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	// Make cwd a git repo so the ancestor walk is bounded by the repo root.
	writeFile(t, filepath.Join(tmp, "proj", ".git", "HEAD"), "ref\n")
	t.Setenv("HOME", filepath.Join(tmp, "home"))

	agentDir := filepath.Join(tmp, "agentdir")
	locs := skillLocations(cwd, agentDir, true)
	var dirs []string
	for _, l := range locs {
		dirs = append(dirs, l.dir)
	}
	want := []string{
		// 1. project .pi/skills at cwd
		filepath.Join(cwd, ".pi", "skills"),
		// 2. ancestor .agents/skills: cwd, then repo root (gitRoot now
		// detects the .git DIRECTORY correctly), bounded there
		filepath.Join(cwd, ".agents", "skills"),
		filepath.Join(tmp, "proj", ".agents", "skills"),
		// 3. agent-dir skills
		filepath.Join(agentDir, "skills"),
		// 4. user .agents/skills
		filepath.Join(tmp, "home", ".agents", "skills"),
	}
	if !reflect.DeepEqual(dirs, want) {
		t.Errorf("dirs = %v\nwant %v", dirs, want)
	}
}

// ---------- pins & config ----------

func TestCollectPinSpecs(t *testing.T) {
	tmp := t.TempDir()
	cwd := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(filepath.Join(cwd, ".pi"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(tmp, "home"))

	writeFile(t, filepath.Join(cwd, ".pi", "pil.json"), `{"skills": ["proj-pin"]}`)
	agentDir := filepath.Join(tmp, "agentdir")
	writeFile(t, filepath.Join(agentDir, "pil.json"), `{"skills": ["global-pin"]}`)

	collected, warnings := collectPinSpecs(cliOptions{pilSkills: []string{"cli-pin"}}, cwd, agentDir, true)
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	want := []pinSpec{{Skill: "proj-pin"}, {Skill: "global-pin"}, {Skill: "cli-pin"}}
	if !reflect.DeepEqual(collected.Specs, want) {
		t.Errorf("specs = %v, want %v", collected.Specs, want)
	}

	// Untrusted project: project config ignored.
	collected, _ = collectPinSpecs(cliOptions{}, cwd, agentDir, false)
	if !reflect.DeepEqual(collected.Specs, []pinSpec{{Skill: "global-pin"}}) {
		t.Errorf("untrusted specs = %v", collected.Specs)
	}

	// --pil-config replaces discovery.
	cfgPath := filepath.Join(tmp, "custom.json")
	writeFile(t, cfgPath, `{"skills": ["custom-pin"]}`)
	collected, _ = collectPinSpecs(cliOptions{configPath: cfgPath}, cwd, agentDir, true)
	if !reflect.DeepEqual(collected.Specs, []pinSpec{{Skill: "custom-pin"}}) {
		t.Errorf("config override specs = %v", collected.Specs)
	}

	// Config "files" map merges (global overrides project); inline objects ride along.
	writeFile(t, filepath.Join(cwd, ".pi", "pil.json"),
		`{"skills": [{"skill": "p", "files": ["inline/*"]}], "files": {"p": ["proj/*"]}}`)
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"files": {"g": ["glob/*"], "p": ["global/*"]}}`)
	collected, _ = collectPinSpecs(cliOptions{}, cwd, agentDir, true)
	if !reflect.DeepEqual(collected.Files["g"], []string{"glob/*"}) {
		t.Errorf("files[g] = %v", collected.Files["g"])
	}
	// Global map overrode the project map entry, but the inline object survives.
	if !reflect.DeepEqual(collected.Files["p"], []string{"global/*"}) {
		t.Errorf("files[p] = %v (want global override)", collected.Files["p"])
	}
	if len(collected.Specs) != 1 || !reflect.DeepEqual(collected.Specs[0].Files, []string{"inline/*"}) {
		t.Errorf("inline files spec lost: %+v", collected.Specs)
	}
}

func TestPreambleSourcesAndPrecedence(t *testing.T) {
	tmp := t.TempDir()
	cwd := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(tmp, "home"))
	agentDir := filepath.Join(tmp, "agentdir")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}

	// Global skills location so pins resolve.
	userAgents := filepath.Join(tmp, "home", ".agents", "skills")
	for _, n := range []string{"alpha", "beta", "gamma", "delta", "epsilon"} {
		makeSkillDir(t, userAgents, n)
	}

	// Inline object preamble (global config).
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": ["alpha", {"skill": "beta", "preamble": "inline beta"}]}`)

	// Plain string pin without any preamble resolves with none.
	pins, warnings := resolvePins(cliOptions{}, cwd, agentDir, true)
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	got := map[string]string{}
	for _, p := range pins {
		got[p.Name] = p.Preamble
	}
	if got["alpha"] != "" {
		t.Errorf("alpha preamble = %q, want empty", got["alpha"])
	}
	if got["beta"] != "inline beta" {
		t.Errorf("beta preamble = %q, want %q", got["beta"], "inline beta")
	}

	// Preambles map form: pin as plain string + separate map.
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": ["alpha", "gamma"], "preambles": {"gamma": "map gamma"}}`)
	pins, warnings = resolvePins(cliOptions{}, cwd, agentDir, true)
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	got = map[string]string{} //nolint:govet // reused accumulator
	for _, p := range pins {
		got[p.Name] = p.Preamble
	}
	if got["gamma"] != "map gamma" {
		t.Errorf("gamma preamble = %q, want %q", got["gamma"], "map gamma")
	}

	// CLI flag beats the preambles map.
	pins, _ = resolvePins(cliOptions{preambles: map[string]string{"gamma": "cli gamma"}}, cwd, agentDir, true)
	got = map[string]string{}
	for _, p := range pins {
		got[p.Name] = p.Preamble
	}
	if got["gamma"] != "cli gamma" {
		t.Errorf("gamma preamble = %q, want %q", got["gamma"], "cli gamma")
	}

	// Inline object beats the preambles map.
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": [{"skill": "delta", "preamble": "inline delta"}], "preambles": {"delta": "map delta"}}`)
	pins, _ = resolvePins(cliOptions{}, cwd, agentDir, true)
	got = map[string]string{}
	for _, p := range pins {
		got[p.Name] = p.Preamble
	}
	if got["delta"] != "inline delta" {
		t.Errorf("delta preamble = %q, want %q (inline must beat map)", got["delta"], "inline delta")
	}

	// Preamble keyed by declared name matches a path-pinned skill.
	epsilonFile := filepath.Join(userAgents, "epsilon", "SKILL.md")
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": ["`+epsilonFile+`"], "preambles": {"epsilon": "name-keyed"}}`)
	pins, _ = resolvePins(cliOptions{}, cwd, agentDir, true)
	if len(pins) != 1 || pins[0].Preamble != "name-keyed" {
		t.Fatalf("pins = %+v, want epsilon with name-keyed preamble", pins)
	}
}

func TestPreambleRenderedInEnforcementFile(t *testing.T) {
	skillDir := makeSkillDir(t, t.TempDir(), "pinned")
	pins := []skillRef{{
		Name:     "pinned",
		Dir:      skillDir,
		File:     filepath.Join(skillDir, "SKILL.md"),
		Preamble: "When communicating, always follow this rule:",
	}}
	path, err := writeEnforcementFile(pins)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if !strings.Contains(s, "<preamble>\nWhen communicating, always follow this rule:\n</preamble>") {
		t.Errorf("preamble element missing or wrong:\n%s", s)
	}
	// Preamble must come before the skill body.
	pIdx := strings.Index(s, "<preamble>")
	bIdx := strings.Index(s, "# Test")
	if pIdx < 0 || bIdx < 0 || pIdx > bIdx {
		t.Errorf("preamble must precede skill body; preamble@%d body@%d", pIdx, bIdx)
	}
	// XML escaping in preamble text.
	pins[0].Preamble = `Use <tags> & "quotes"`
	path2, err := writeEnforcementFile(pins)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path2)
	data2, _ := os.ReadFile(path2)
	if !strings.Contains(string(data2), "Use &lt;tags&gt; &amp; &quot;quotes&quot;") {
		t.Errorf("preamble not escaped: %s", data2)
	}
}

func TestParseArgsPreambleFlag(t *testing.T) {
	opts, err := parseArgs([]string{"--pil-preamble", "grilling=Ask harder:"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.preambles["grilling"] != "Ask harder:" {
		t.Errorf("preambles = %v", opts.preambles)
	}
	if _, err := parseArgs([]string{"--pil-preamble", "noequals"}); err == nil {
		t.Error("missing = must error")
	}
	if _, err := parseArgs([]string{"--pil-preamble", "=text"}); err == nil {
		t.Error("empty skill name must error")
	}
	// Last --pil-preamble for the same skill wins.
	opts, err = parseArgs([]string{"--pil-preamble", "a=1", "--pil-preamble", "a=2"})
	if err != nil {
		t.Fatal(err)
	}
	if opts.preambles["a"] != "2" {
		t.Errorf("last preamble must win: %v", opts.preambles)
	}
}

func TestBuildPiArgsNoPinsLeavesArgsUntouched(t *testing.T) {
	user := []string{"-p", "hi"}
	got := buildPiArgs(user, nil, t.TempDir(), t.TempDir(), true)
	if !reflect.DeepEqual(got, user) {
		t.Errorf("got %v want %v", got, user)
	}
}

func TestBuildPiArgsWithPins(t *testing.T) {
	tmp := t.TempDir()
	cwd := filepath.Join(tmp, "cwd")
	agentDir := filepath.Join(tmp, "agent")
	for _, d := range []string{filepath.Join(cwd, ".pi"), agentDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	// Discovered APPEND_SYSTEM.md files must be re-attached.
	writeFile(t, filepath.Join(cwd, ".pi", "APPEND_SYSTEM.md"), "project append")
	writeFile(t, filepath.Join(agentDir, "APPEND_SYSTEM.md"), "global append")

	skillDir := makeSkillDir(t, t.TempDir(), "pinned")
	pins := []skillRef{{Name: "pinned", Dir: skillDir, File: filepath.Join(skillDir, "SKILL.md")}}

	got := buildPiArgs([]string{"-p", "hi"}, pins, cwd, agentDir, true)

	// First four args: two discovered append files.
	if got[0] != "--append-system-prompt" || got[1] != filepath.Join(cwd, ".pi", "APPEND_SYSTEM.md") {
		t.Errorf("project append missing: %v", got[:2])
	}
	if got[2] != "--append-system-prompt" || got[3] != filepath.Join(agentDir, "APPEND_SYSTEM.md") {
		t.Errorf("global append missing: %v", got[:4])
	}
	// Then --skill dir, --append SKILL.md, enforcement temp, then user args.
	rest := got[4:]
	if rest[0] != "--skill" || rest[1] != skillDir {
		t.Errorf("skill flag wrong: %v", rest[:2])
	}
	if rest[2] != "--append-system-prompt" {
		t.Errorf("enforcement flag missing: %v", rest[2:4])
	}
	enforceFile := rest[3]
	data, err := os.ReadFile(enforceFile)
	if err != nil {
		t.Fatalf("enforcement file unreadable: %v", err)
	}
	s := string(data)
	if !strings.Contains(s, "MANDATORY ALWAYS-ON SKILLS") {
		t.Error("enforcement intro missing")
	}
	if !strings.Contains(s, `<forced_skill name="pinned"`) {
		t.Error("forced_skill wrapper missing")
	}
	if !strings.Contains(s, "# Test") {
		t.Error("skill body missing")
	}
	if strings.Contains(s, "description: A test skill.") {
		t.Error("frontmatter must be stripped from inlined content")
	}
	if !reflect.DeepEqual(rest[4:], []string{"-p", "hi"}) {
		t.Errorf("user args wrong: %v", rest[4:])
	}
}

// ---------- trust ----------

func TestProjectTrustedNearestEntryWins(t *testing.T) {
	tmp := t.TempDir()
	agentDir := filepath.Join(tmp, "agent")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(agentDir, "trust.json"),
		`{"/opt": true, "/opt/parent": false}`)
	if projectTrusted(agentDir, "/opt/parent/child") {
		t.Error("nearest entry (/opt/parent=false) must win, making the child untrusted")
	}
	if !projectTrusted(agentDir, "/opt/other") {
		t.Error("/opt=true must trust /opt/other")
	}
	if projectTrusted(agentDir, "/unrelated") {
		t.Error("unlisted path must be untrusted")
	}
}

// ---------- git root ----------

func TestGitRootBoundsAncestorWalk(t *testing.T) {
	tmp := t.TempDir()
	writeFile(t, filepath.Join(tmp, "proj", ".git", "HEAD"), "ref\n")
	if got := gitRoot(filepath.Join(tmp, "proj", "a", "b")); got != filepath.Join(tmp, "proj") {
		t.Errorf("gitRoot = %q", got)
	}
	// Not in a repo: pi bounds the ancestor walk at the filesystem root
	// (docs/skills.md: "up to git repo root, or filesystem root when not
	// in a repo"). gitRoot mirrors that by returning the fs root.
	if got := gitRoot(filepath.Join(tmp, "plain")); got != "/" {
		t.Errorf("non-repo gitRoot = %q, want /", got)
	}
}

// ---------- companion files ----------

func TestMatchRelPath(t *testing.T) {
	cases := []struct {
		pattern string
		rel     string
		want    bool
	}{
		{"references/*.md", "references/a.md", true},
		{"references/*.md", "references/sub/a.md", false}, // * stays in one segment
		{"references/*.md", "references/a.json", false},
		{"references/**", "references/a.md", true},
		{"references/**", "references/sub/deep/b.md", true},
		{"references/**", "other/a.md", false},
		{"**/*.md", "a.md", true},     // ** matches zero segments
		{"**/*.md", "x/y/a.md", true}, // ** matches many segments
		{"examples/*", "examples/e.md", true},
		{"examples/*", "examples/e.json", true},
		{"README.md", "README.md", true},
		{"README.md", "sub/README.md", false},
		{"**", "anything/at/all", true},
		{"a?c.md", "abc.md", true},
		{"a?c.md", "abbc.md", false},
		{"refs/[ab].md", "refs/a.md", true},
		{"refs/[ab].md", "refs/c.md", false},
	}
	for _, c := range cases {
		if got := matchRelPath(c.pattern, c.rel); got != c.want {
			t.Errorf("matchRelPath(%q, %q) = %v, want %v", c.pattern, c.rel, got, c.want)
		}
	}
}

// buildFileSkillDir creates a skill dir with companion files for tests.
func buildFileSkillDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	writeFile(t, filepath.Join(dir, "SKILL.md"), "---\nname: fileskill\ndescription: d\n---\nbody")
	writeFile(t, filepath.Join(dir, "references", "a.md"), "ref A")
	writeFile(t, filepath.Join(dir, "references", "b.md"), "ref B")
	writeFile(t, filepath.Join(dir, "references", "sub", "c.md"), "ref C")
	writeFile(t, filepath.Join(dir, "examples", "e.md"), "example E")
	writeFile(t, filepath.Join(dir, "node_modules", "dep.md"), "dep")
	writeFile(t, filepath.Join(dir, ".hidden.md"), "hidden")
	return dir
}

func TestResolveSkillFilesPatterns(t *testing.T) {
	dir := buildFileSkillDir(t)

	rel := func(files []skillFile) []string {
		var out []string
		for _, f := range files {
			out = append(out, f.Rel)
		}
		return out
	}

	files, warnings := resolveSkillFiles(dir, []string{"references/*.md"})
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	if !reflect.DeepEqual(rel(files), []string{"references/a.md", "references/b.md"}) {
		t.Errorf("files = %v", rel(files))
	}

	// ** recurses; SKILL.md, hidden, node_modules never match.
	files, warnings = resolveSkillFiles(dir, []string{"**"})
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	if !reflect.DeepEqual(rel(files), []string{"examples/e.md", "references/a.md", "references/b.md", "references/sub/c.md"}) {
		t.Errorf("files = %v", rel(files))
	}

	// Overlapping patterns dedupe; pattern order is kept.
	files, _ = resolveSkillFiles(dir, []string{"references/*.md", "references/**"})
	if !reflect.DeepEqual(rel(files), []string{"references/a.md", "references/b.md", "references/sub/c.md"}) {
		t.Errorf("dedupe order = %v", rel(files))
	}

	// Unmatched pattern warns.
	files, warnings = resolveSkillFiles(dir, []string{"nomatch/*"})
	if len(files) != 0 || len(warnings) != 1 {
		t.Errorf("files = %v warnings = %v", files, warnings)
	}

	// Invalid pattern warns instead of panicking.
	_, warnings = resolveSkillFiles(dir, []string{"bad[/x"})
	if len(warnings) != 1 {
		t.Errorf("invalid pattern warnings = %v", warnings)
	}
}

func TestResolveSkillFilesBudgetAndBinary(t *testing.T) {
	dir := buildFileSkillDir(t)
	// A file too big for the budget (one byte over).
	big := strings.Repeat("x", maxInlineFilesBytes+1)
	writeFile(t, filepath.Join(dir, "big", "big.md"), big)
	// A binary file.
	writeFileRaw(t, filepath.Join(dir, "blob", "img.png"), []byte("PNG\x00\x01\x02"))

	files, warnings := resolveSkillFiles(dir, []string{"**"})
	rels := map[string]bool{}
	for _, f := range files {
		rels[f.Rel] = true
	}
	if rels["big/big.md"] {
		t.Error("oversized file must be skipped")
	}
	if rels["blob/img.png"] {
		t.Error("binary file must be skipped")
	}
	if !rels["references/a.md"] {
		t.Error("normal file must survive budget check")
	}
	joined := strings.Join(warnings, "\n")
	if !strings.Contains(joined, "budget") || !strings.Contains(joined, "binary") {
		t.Errorf("warnings must mention budget and binary skip: %v", warnings)
	}
}

func TestFilePatternsPrecedence(t *testing.T) {
	tmp := t.TempDir()
	cwd := filepath.Join(tmp, "proj")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HOME", filepath.Join(tmp, "home"))
	agentDir := filepath.Join(tmp, "agentdir")
	if err := os.MkdirAll(agentDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Install under the global skills location with the declared name.
	userAgents := filepath.Join(tmp, "home", ".agents", "skills")
	writeFile(t, filepath.Join(userAgents, "fileskill", "SKILL.md"), "---\nname: fileskill\ndescription: d\n---\nbody")
	writeFile(t, filepath.Join(userAgents, "fileskill", "references", "a.md"), "ref A")
	writeFile(t, filepath.Join(userAgents, "fileskill", "references", "sub", "c.md"), "ref C")
	writeFile(t, filepath.Join(userAgents, "fileskill", "examples", "e.md"), "example E")

	rels := func(pins []skillRef) map[string][]string {
		out := map[string][]string{}
		for _, p := range pins {
			var r []string
			for _, f := range p.ExtraFiles {
				r = append(r, f.Rel)
			}
			out[p.Name] = r
		}
		return out
	}

	// Config map form.
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": ["fileskill"], "files": {"fileskill": ["references/*.md"]}}`)
	pins, warnings := resolvePins(cliOptions{}, cwd, agentDir, true)
	if len(warnings) != 0 {
		t.Fatalf("warnings: %v", warnings)
	}
	if got := rels(pins)["fileskill"]; !reflect.DeepEqual(got, []string{"references/a.md"}) {
		t.Errorf("map form files = %v", got)
	}

	// Inline object beats the map.
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": [{"skill": "fileskill", "files": ["examples/*"]}], "files": {"fileskill": ["references/*.md"]}}`)
	pins, _ = resolvePins(cliOptions{}, cwd, agentDir, true)
	if got := rels(pins)["fileskill"]; !reflect.DeepEqual(got, []string{"examples/e.md"}) {
		t.Errorf("inline beats map: %v", got)
	}

	// CLI beats everything.
	pins, _ = resolvePins(cliOptions{files: map[string][]string{"fileskill": {"references/sub/*.md"}}}, cwd, agentDir, true)
	if got := rels(pins)["fileskill"]; !reflect.DeepEqual(got, []string{"references/sub/c.md"}) {
		t.Errorf("cli beats inline: %v", got)
	}

	// Map keyed by declared name applies to a path-pinned skill.
	writeFile(t, filepath.Join(agentDir, "pil.json"),
		`{"skills": ["`+filepath.Join(userAgents, "fileskill")+`"], "files": {"fileskill": ["examples/*"]}}`)
	pins, _ = resolvePins(cliOptions{}, cwd, agentDir, true)
	if got := rels(pins)["fileskill"]; !reflect.DeepEqual(got, []string{"examples/e.md"}) {
		t.Errorf("declared-name key on path pin: %v", got)
	}

	// No files configured -> none attached, no warnings.
	writeFile(t, filepath.Join(agentDir, "pil.json"), `{"skills": ["fileskill"]}`)
	pins, warnings = resolvePins(cliOptions{}, cwd, agentDir, true)
	if len(pins) != 1 || len(pins[0].ExtraFiles) != 0 || len(warnings) != 0 {
		t.Errorf("no-files case: pins=%+v warnings=%v", pins, warnings)
	}
}

func TestEnforcementFileRendersExtraFiles(t *testing.T) {
	skillDir := buildFileSkillDir(t)
	aContent, _ := os.ReadFile(filepath.Join(skillDir, "references", "a.md"))
	eContent, _ := os.ReadFile(filepath.Join(skillDir, "examples", "e.md"))
	pins := []skillRef{{
		Name: "fileskill",
		Dir:  skillDir,
		File: filepath.Join(skillDir, "SKILL.md"),
		ExtraFiles: []skillFile{
			{Rel: "references/a.md", Abs: filepath.Join(skillDir, "references", "a.md"), Content: aContent},
			{Rel: "examples/e.md", Abs: filepath.Join(skillDir, "examples", "e.md"), Content: eContent},
		},
	}}
	path, err := writeEnforcementFile(pins)
	if err != nil {
		t.Fatal(err)
	}
	defer os.Remove(path)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := string(data)
	if !strings.Contains(s, `<skill_file path="references/a.md">`) {
		t.Errorf("references/a.md block missing:\n%s", s)
	}
	if !strings.Contains(s, "ref A") || !strings.Contains(s, "example E") {
		t.Errorf("file contents missing:\n%s", s)
	}
	if !strings.Contains(s, `<skill_file path="examples/e.md">`) {
		t.Errorf("examples/e.md block missing:\n%s", s)
	}
	// Body first, then files, in pattern order.
	iBody := strings.Index(s, "body")
	iA := strings.Index(s, "references/a.md")
	iE := strings.Index(s, "examples/e.md")
	if iBody < 0 || iA < 0 || iE < 0 || !(iBody < iA && iA < iE) {
		t.Errorf("render order wrong: body@%d a@%d e@%d", iBody, iA, iE)
	}
	if !strings.Contains(s, "</skill_file>\n\n<skill_file") {
		t.Errorf("file blocks must be separated:\n%s", s)
	}
}

func TestParseArgsFileFlag(t *testing.T) {
	opts, err := parseArgs([]string{"--pil-file", "grilling=references/*.md", "--pil-file", "grilling=examples/*", "--pil-file", "other=**"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(opts.files["grilling"], []string{"references/*.md", "examples/*"}) {
		t.Errorf("files[grilling] = %v (patterns must accumulate)", opts.files["grilling"])
	}
	if !reflect.DeepEqual(opts.files["other"], []string{"**"}) {
		t.Errorf("files[other] = %v", opts.files["other"])
	}
	if _, err := parseArgs([]string{"--pil-file", "noequals"}); err == nil {
		t.Error("missing = must error")
	}
	if _, err := parseArgs([]string{"--pil-file", "skill="}); err == nil {
		t.Error("empty glob must error")
	}
	if _, err := parseArgs([]string{"--pil-file"}); err == nil {
		t.Error("missing value must error")
	}
}
