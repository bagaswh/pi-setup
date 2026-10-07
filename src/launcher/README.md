# pil — pi launcher with pinned skills

`pil` is a drop-in wrapper for the `pi` coding agent that makes selected
skills **always present in the system prompt**, instead of merely listed
as available.

## Why

`pi --skill <path>` uses progressive disclosure: only the skill's
*description* goes into `<available_skills>`, and the model is expected to
read the file when a task "matches". Nothing guarantees it ever does. If
you want a skill such as `asd-ste100` to define the model's communication
style unconditionally, description-listing is not enforcement.

`pil` enforces it:

1. Resolves each pinned skill name across pi's own skill discovery
   locations (mirroring pi's scan order and project-trust gates).
2. Registers the skill with `--skill <dir>` (so `/skill:name` and the
   skill tools keep working for companion files).
3. Appends the skill's full body — frontmatter stripped — to the system
   prompt with `--append-system-prompt`, wrapped in an enforcement
   preamble that tells the model these are standing instructions, not
   on-demand reference material.
4. Re-attaches any `.pi/APPEND_SYSTEM.md` / `~/.pi/agent/APPEND_SYSTEM.md`
   that pi would otherwise stop auto-discovering once an explicit
   `--append-system-prompt` is present.

Everything else on the command line is forwarded to `pi` verbatim.

## Install

```bash
cd src/launcher
go build -o pil .
cp pil ~/.local/bin/pil   # or anywhere on PATH
```

## Pin a skill

Global (applies everywhere):

```bash
echo '{"skills": ["asd-ste100"]}' > ~/.pi/agent/pil.json
```

The skill must exist in a location pi discovers. For a repo-local skill
like this repo's `.pi/skills/asd-ste100`, expose it globally once:

```bash
ln -s "$PWD/.pi/skills/asd-ste100" ~/.agents/skills/asd-ste100
```

Project-only pins: create `<project>/.pi/pil.json` instead (honored only
when pi trusts the project).

## Per-skill preamble

Each pinned skill can carry an optional opener — a line rendered inside
its `<forced_skill>` block, directly before the skill body, telling the
model how to apply it:

```json
{
  "skills": ["asd-ste100"],
  "preambles": {"asd-ste100": "When communicating, always follow this rule:"}
}
```

Equivalent inline form (preamble attached to its pin entry directly):

```json
{
  "skills": [
    {"skill": "asd-ste100", "preamble": "When communicating, always follow this rule:"}
  ]
}
```

Ad-hoc per run, overriding config:

```bash
pil --pil-preamble "asd-ste100=When communicating, always follow this rule:"
```

Precedence: `--pil-preamble` > inline object > `"preambles"` map. Preamble
keys match the skill's declared name (frontmatter `name:`), so they work
whether the pin itself was configured as a name or a path.

## Load companion files

By default only `SKILL.md` is inlined. Glob patterns (relative to the
skill directory) inline more files, each in its own
`<skill_file path="…">` block after the skill body:

```json
{
  "skills": ["asd-ste100"],
  "files": {"asd-ste100": ["references/*.md", "examples/**"]}
}
```

Or inline per pin, or per run (same precedence rules as preambles):

```json
{"skills": [{"skill": "asd-ste100", "files": ["references/*"]}]}
```

```bash
pil --pil-file "asd-ste100=references/*.md"   # repeatable, per skill
```

Pattern semantics: `*` and `?` stay within one path segment; `**`
matches across directories (including zero), so `references/**` covers
nested files. Hidden entries, `node_modules`, symlinks, `SKILL.md`
itself, and binary files (NUL sniff) never match. A 256 KB per-skill
inline budget drops the overflow with a warning; unmatched patterns and
unreadable files warn on every launch, so typos surface immediately.
Dry-run shows the resolved file list per pin.

## Usage

```bash
pil                     # interactive, with pins from config
pil "fix the bug"       # interactive with an initial prompt
pil -p "summarize"      # non-interactive
pil --pil-skill grilling --pil-skill asd-ste100   # ad-hoc pins for one run
pil --pil-preamble "asd-ste100=Opener text:"      # override one preamble
pil --pil-file "asd-ste100=references/*.md"       # inline companion files
pil --pil-no-pins       # plain pi, ignore pin config
pil --pil-list-skills   # list resolvable skills
pil --pil-dry-run       # show the exact pi command and pinned skills
```

pil flags are consumed before handing off; all other arguments (including
`--`) are forwarded to pi untouched.

## Skill name resolution

Mirrors pi's discovery order (`docs/skills.md`, `core/skills.js`):

1. `<cwd>/.pi/skills/` — trusted projects only
2. `<ancestor>/.agents/skills/` — cwd up to the git root, trusted only
3. `~/.pi/agent/skills/`
4. `~/.agents/skills/`

A pin value that is an existing file or directory is used as-is. A skill
directory is matched by its own name or by the `name:` declared in its
`SKILL.md` frontmatter (pi allows them to differ).

## Trust model

Untrusted projects contribute nothing: their `.pi/skills`, ancestor
`.agents/skills`, `.pi/pil.json`, and `.pi/APPEND_SYSTEM.md` are all
ignored, exactly like pi's own project-resource gating. Global
(`~/.pi/agent/`, `~/.agents/`) resources are always honored. Explicit
`--pil-skill` paths are honored regardless of trust, matching pi's
treatment of explicit `--skill` paths.

## Files

- `main.go` — entry point, orchestration, usage text
- `cli.go` — pil flag parsing (`--pil-*`), everything else forwarded
- `config.go` — pin config discovery/merging (project + global + CLI)
- `skills.go` — skill-name resolution mirroring pi's discovery
- `trust.go` — pi trust.json lookup (nearest-entry-wins)
- `pibuild.go` — pi argv construction, enforcement wrapper, temp file
- `exec.go` — process handoff via `syscall.Exec`
- `plan.go` — dry-run plan printing, stale temp cleanup
