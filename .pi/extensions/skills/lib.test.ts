import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  clampLineWindow,
  DEFAULT_LIST_LIMIT,
  DEFAULT_VIEW_LINES,
  extractFrontmatter,
  findSkill,
  formatSearchHits,
  formatSkillFile,
  formatSkillFrontmatter,
  formatSkillList,
  isLexicallyInside,
  listSkillFiles,
  MAX_LIST_LIMIT,
  MAX_VIEW_LINES,
  MAX_FILE_VIEW_FILES,
  normalizeSkillName,
  loadSkillFileViews,
  loadSkillView,
  normalizeSkillFileList,
  paginateList,
  readSkillFile,
  resolveSkillFile,
  rewriteSkillsPrompt,
  skillToolsActive,
  sliceLineWindow,
  snippetAround,
  splitLines,
  walkSkillTextFiles,
  appendSkillToolsPrompt,
  buildCatalogTree,
  directoryBlurb,
  formatDirectoryList,
  formatSkillTree,
  listDirectory,
  parseAvailableSkillsBlock,
  parseLoadFull,
  SKILL_TOOLS_PROMPT_MARKER,
  SKILL_VIEW_READ_HINT,
  SKILL_VIEW_RELATIVE_HINT,
  type SkillRef,
} from "./lib.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-view-"));
const skillDir = path.join(tmp, "handoff");
const otherDir = path.join(tmp, "other");
const secretFile = path.join(tmp, "secret.env");

const handoff: SkillRef = {
  name: "handoff",
  description: "Compact the current conversation into a handoff document",
  filePath: path.join(skillDir, "SKILL.md"),
  baseDir: skillDir,
  disableModelInvocation: true,
};

before(() => {
  fs.mkdirSync(path.join(skillDir, "agents"), { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  fs.writeFileSync(
    handoff.filePath,
    [
      "---",
      "name: handoff",
      "summary: Compact a conversation",
      "disable-model-invocation: true",
      "---",
      "Write a handoff.",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(skillDir, "agents", "openai.yaml"), "model: test\n");
  fs.writeFileSync(path.join(skillDir, "notes.md"), "companion\n");
  fs.writeFileSync(secretFile, "SECRET=1\n");
  fs.symlinkSync(secretFile, path.join(skillDir, "escape.env"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("normalizeSkillName strips slash prefixes", () => {
  assert.equal(normalizeSkillName("/skill:handoff"), "handoff");
  assert.equal(normalizeSkillName("skill:handoff"), "handoff");
  assert.equal(normalizeSkillName("/skill:handoff now"), "handoff");
  assert.equal(normalizeSkillName("  handoff  "), "handoff");
});

test("findSkill matches name, filePath, and path inside baseDir", () => {
  const skills = [handoff];
  assert.equal(findSkill(skills, "handoff")?.skill.name, "handoff");
  assert.equal(findSkill(skills, handoff.filePath)?.skill.name, "handoff");
  const nested = findSkill(skills, path.join(skillDir, "agents", "openai.yaml"));
  assert.equal(nested?.skill.name, "handoff");
  assert.equal(nested?.pathHint, path.join("agents", "openai.yaml"));
  assert.equal(findSkill(skills, "missing"), undefined);
});

test("resolveSkillFile reads SKILL.md and companion files", () => {
  const skills = [handoff];
  const main = resolveSkillFile(skills, "handoff");
  assert.equal(main.ok, true);
  if (main.ok) {
    assert.equal(main.relPath, "SKILL.md");
    assert.equal(readSkillFile(main.absPath).ok, true);
  }

  const companion = resolveSkillFile(skills, "handoff", "agents/openai.yaml");
  assert.equal(companion.ok, true);
  if (companion.ok) assert.equal(companion.relPath, path.join("agents", "openai.yaml"));
});

test("resolveSkillFile rejects path escape and symlink escape", () => {
  const skills = [handoff];
  const traversal = resolveSkillFile(skills, "handoff", "../secret.env");
  assert.equal(traversal.ok, false);
  if (!traversal.ok) assert.match(traversal.error, /escapes/);

  const abs = resolveSkillFile(skills, "handoff", secretFile);
  assert.equal(abs.ok, false);

  const symlink = resolveSkillFile(skills, "handoff", "escape.env");
  assert.equal(symlink.ok, false);
  if (!symlink.ok) assert.match(symlink.error, /escapes/);
});

test("resolveSkillFile reports unknown skills without dumping the catalog", () => {
  const result = resolveSkillFile([handoff], "not-a-skill");
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /not-a-skill/);
    assert.match(result.error, /skill_list/);
    assert.ok(!result.error.includes("handoff"));
  }
});

test("isLexicallyInside rejects parent and absolute paths", () => {
  assert.equal(isLexicallyInside(skillDir, path.join(skillDir, "SKILL.md")), true);
  assert.equal(isLexicallyInside(skillDir, path.join(skillDir, "..", "secret.env")), false);
  assert.equal(isLexicallyInside(skillDir, secretFile), false);
});

test("listSkillFiles skips hidden names", () => {
  fs.writeFileSync(path.join(skillDir, ".hidden"), "x");
  const names = listSkillFiles(skillDir);
  assert.ok(names.includes("SKILL.md"));
  assert.ok(names.includes("agents/"));
  assert.ok(!names.includes(".hidden"));
});

test("rewriteSkillsPrompt swaps Pi read/bash hints and location paths", () => {
  const prompt = [
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
    "  <skill>",
    "    <name>handoff</name>",
    "    <description>Compact the current conversation</description>",
    `    <location>${handoff.filePath}</location>`,
    "  </skill>",
    "</available_skills>",
  ].join("\n");

  const rewritten = rewriteSkillsPrompt(prompt);
  assert.ok(rewritten.includes(SKILL_VIEW_READ_HINT));
  assert.ok(rewritten.includes(SKILL_VIEW_RELATIVE_HINT));
  assert.ok(!rewritten.includes("Use the read tool to load a skill"));
  assert.ok(rewritten.includes('skill_view name="handoff"'));
  assert.ok(!rewritten.includes(handoff.filePath));
});

test("parseAvailableSkillsBlock rebuilds a catalog from a child prompt", () => {
  const prompt = [
    "persona body",
    "<available_skills>",
    "  <skill>",
    "    <name>handoff</name>",
    "    <description>Compact the current conversation</description>",
    `    <location>${handoff.filePath}</location>`,
    "  </skill>",
    "</available_skills>",
    "Current date: today",
  ].join("\n");

  const refs = parseAvailableSkillsBlock(prompt);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "handoff");
  assert.equal(refs[0].filePath, handoff.filePath);
  assert.equal(refs[0].baseDir, skillDir);

  // No block, unterminated block, and entries without a location resolve to nothing.
  assert.equal(parseAvailableSkillsBlock("plain persona").length, 0);
  assert.equal(
    parseAvailableSkillsBlock("<available_skills><skill><name>x</name></skill>").length,
    0,
  );
  // Escaped/unterminated blocks never leak entries past the closing tag.
  assert.equal(
    parseAvailableSkillsBlock(
      `<available_skills><skill><name>a</name><location>${handoff.filePath}</location></skill>`,
    ).length,
    0,
  );
});

test("formatSkillList names every skill and marks slash-only", () => {
  const text = formatSkillList([handoff]);
  assert.match(text, /^- handoff \[slash-only\]$/m);
  assert.ok(!text.includes(handoff.description));
  assert.ok(!text.includes("disable-model-invocation"));
});

test("formatSkillList printDescription appends descriptions", () => {
  const text = formatSkillList([handoff], { printDescription: true });
  assert.match(
    text,
    /^- handoff \[slash-only\]: Compact the current conversation into a handoff document$/m,
  );
});

test("formatSkillList printSummary prefers summary, falls back to description", () => {
  const withSummary: SkillRef = { ...handoff, summary: "Compact a conversation" };
  const without: SkillRef = { ...handoff, summary: undefined };
  const short = formatSkillList([withSummary, without], { printSummary: true });
  assert.match(short, /^- handoff \[slash-only\]: Compact a conversation$/m);
  assert.match(
    short,
    /^- handoff \[slash-only\]: Compact the current conversation into a handoff document$/m,
  );
});

test("formatSkillFrontmatter prints YAML without the body", () => {
  const raw = fs.readFileSync(handoff.filePath, "utf8");
  const text = formatSkillFrontmatter({
    skill: handoff,
    frontmatter: extractFrontmatter(raw),
  });
  assert.match(text, /# skill handoff  frontmatter/);
  assert.match(text, /summary: Compact a conversation/);
  assert.match(text, /disable-model-invocation: true/);
  assert.ok(!text.includes("Write a handoff"));
  assert.match(text, /Call skill_view with name=handoff to load instructions/);
  const full = formatSkillFrontmatter({
    skill: handoff,
    frontmatter: "name: handoff\nload-full: true",
  });
  assert.match(full, /load-full is set/);
  assert.match(full, /load the whole file/);
});

test("paginateList pages by skill count", () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  const first = paginateList(items);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, DEFAULT_LIST_LIMIT);
  assert.equal(first.from, 0);
  assert.equal(first.to, DEFAULT_LIST_LIMIT - 1);
  assert.equal(first.remaining, 25);
  assert.deepEqual(first.items, items.slice(0, DEFAULT_LIST_LIMIT));

  const second = paginateList(items, first.to + 1);
  assert.equal(second.from, DEFAULT_LIST_LIMIT);
  assert.equal(second.to, DEFAULT_LIST_LIMIT * 2 - 1);
  assert.equal(second.remaining, 5);

  const last = paginateList(items, 40);
  assert.equal(last.from, 40);
  assert.equal(last.to, 44);
  assert.equal(last.remaining, 0);

  const past = paginateList(items, 100);
  assert.equal(past.items.length, 0);
  assert.equal(past.total, 45);

  const clamped = paginateList(items, 0, 999);
  assert.equal(clamped.limit, MAX_LIST_LIMIT);
});

test("formatSkillList pagination footer names the next offset", () => {
  const catalog = Array.from({ length: 25 }, (_, i) => ({
    ...handoff,
    name: `skill-${String(i).padStart(2, "0")}`,
    disableModelInvocation: false,
  }));
  const page = paginateList(catalog, 0, 20);
  const text = formatSkillList(page.items, {
    from: page.from,
    to: page.to,
    total: page.total,
    remaining: page.remaining,
    offset: page.offset,
  });
  assert.match(text, /printed 0 to 19 of 25, remaining 5/);
  assert.match(text, /offset=20 to continue/);
  assert.ok(!text.includes("skill-20"));
});

test("clampLineWindow returns the full file when it fits or load-full is set", () => {
  const first = clampLineWindow({ total: 568 });
  assert.deepEqual(first, {
    from: 0,
    to: DEFAULT_VIEW_LINES - 1,
    remaining: 568 - DEFAULT_VIEW_LINES,
    total: 568,
  });

  const fits = clampLineWindow({ total: 150 });
  assert.deepEqual(fits, { from: 0, to: 149, remaining: 0, total: 150 });

  const full = clampLineWindow({ total: 568, loadFull: true });
  assert.deepEqual(full, { from: 0, to: 567, remaining: 0, total: 568 });

  const paged = clampLineWindow({ total: 568, loadFull: true, from: 80 });
  assert.equal(paged.from, 80);
  assert.equal(paged.to, 80 + DEFAULT_VIEW_LINES - 1);

  const next = clampLineWindow({ total: 568, from: 80 });
  assert.equal(next.from, 80);
  assert.equal(next.to, 80 + DEFAULT_VIEW_LINES - 1);
  assert.equal(next.remaining, 568 - (next.to + 1));

  const capped = clampLineWindow({ total: 568, from: 80, to: 1000 });
  assert.equal(capped.from, 80);
  assert.equal(capped.to, 80 + MAX_VIEW_LINES - 1);
  assert.equal(capped.remaining, 568 - (capped.to + 1));

  const empty = clampLineWindow({ total: 0 });
  assert.deepEqual(empty, { from: 0, to: 0, remaining: 0, total: 0 });
});

test("parseLoadFull reads the YAML flag", () => {
  assert.equal(parseLoadFull("name: x\nload-full: true"), true);
  assert.equal(parseLoadFull("load-full: yes"), true);
  assert.equal(parseLoadFull("name: x\nload-full: false"), false);
  assert.equal(parseLoadFull("name: x"), false);
  assert.equal(parseLoadFull(undefined), false);
});

test("splitLines drops a trailing newline and sliceLineWindow is 0-based inclusive", () => {
  const content = ["one", "two", "three", "four", ""].join("\n");
  assert.deepEqual(splitLines(content), ["one", "two", "three", "four"]);
  assert.equal(sliceLineWindow(content, 1, 2), "two\nthree");
});

test("formatSkillFile prints the line window and a next-call hint", () => {
  const text = formatSkillFile({
    skill: handoff,
    relPath: "SKILL.md",
    content: "body",
    from: 0,
    to: 79,
    remaining: 488,
    total: 568,
  });
  assert.match(
    text,
    /\(printed from line 0 to line 79, remaining 488 lines\)/,
  );
  assert.match(
    text,
    /Call skill_view with name=handoff from=80 to=159 to load the next window/,
  );

  const rest = formatSkillFile({
    skill: handoff,
    relPath: "SKILL.md",
    content: "tail",
    from: 480,
    to: 567,
    remaining: 0,
    total: 568,
  });
  assert.match(
    rest,
    /\(printed from line 480 to line 567, remaining 0 lines\)/,
  );
  assert.ok(!rest.includes("to load the next window"));
});

test("extractFrontmatter reads the YAML fence", () => {
  const raw = fs.readFileSync(handoff.filePath, "utf8");
  const fm = extractFrontmatter(raw);
  assert.ok(fm);
  assert.match(fm, /name: handoff/);
  assert.ok(!fm.includes("Write a handoff"));
  assert.equal(extractFrontmatter("no fence here"), undefined);
});

test("skillToolsActive follows the selected-tools allowlist", () => {
  assert.equal(skillToolsActive(undefined), true);
  assert.equal(skillToolsActive([]), true);
  assert.equal(skillToolsActive(["read", "bash"]), false);
  assert.equal(skillToolsActive(["read", "skill_view"]), true);
  assert.equal(skillToolsActive(["skill_list"]), true);
  assert.equal(skillToolsActive(["skill_read_frontmatter"]), true);
  assert.equal(skillToolsActive(["skill_search"]), true);
  assert.equal(skillToolsActive(["skill_file_view"]), true);
  assert.equal(skillToolsActive(["skill_find"]), true);
});

test("walkSkillTextFiles recurses and skips binaries and escapes", () => {
  const files = walkSkillTextFiles(handoff);
  const rels = files.map((f) => f.relPath);
  assert.ok(rels.includes("SKILL.md"));
  assert.ok(rels.includes(path.join("agents", "openai.yaml")));
  assert.ok(rels.includes("notes.md"));
  assert.ok(!rels.includes("escape.env"));
});

test("snippetAround centers the first query term", () => {
  const text = "alpha beta gamma composer.lock delta";
  const snippet = snippetAround(text, "composer lock", 20);
  assert.match(snippet, /composer\.lock/);
  assert.ok(snippet.startsWith("…") || snippet.includes("gamma"));
});

test("formatSearchHits pages and points at skill_view", () => {
  const text = formatSearchHits(
    [
      {
        skill: "handoff",
        file: "SKILL.md",
        score: 12.34,
        snippet: "Write a handoff.",
      },
    ],
    { searchTerm: "handoff", from: 0, to: 0, total: 1, remaining: 0 },
  );
  assert.match(text, /Search "handoff" \(printed 0 to 0 of 1, remaining 0\)/);
  assert.match(text, /score 12.3/);
  assert.match(text, /Call skill_view with name=handoff to load this file/);
});

test("appendSkillToolsPrompt is idempotent on the heading marker", () => {
  const body = `${SKILL_TOOLS_PROMPT_MARKER}\nOpen skill files with skill_view.`;
  const once = appendSkillToolsPrompt("persona", body);
  assert.ok(once.startsWith("persona\n\n"));
  assert.ok(once.includes(SKILL_TOOLS_PROMPT_MARKER));
  const twice = appendSkillToolsPrompt(once, body);
  assert.equal(twice, once);
  assert.equal(appendSkillToolsPrompt("persona", "   "), "persona");
});

test("loadSkillFileViews reads several companions and rejects escapes", () => {
  const skills = [handoff];
  const empty = loadSkillFileViews(skills, "handoff", ["  ", ""]);
  assert.equal(empty.views.length, 0);
  assert.match(empty.text, /files is empty/);

  const ok = loadSkillFileViews(skills, "handoff", [
    "notes.md",
    "agents/openai.yaml",
    "notes.md",
  ]);
  assert.equal(ok.errors.length, 0);
  assert.equal(ok.views.length, 2);
  assert.equal(ok.views[0].relPath, "notes.md");
  assert.equal(ok.views[1].relPath, path.join("agents", "openai.yaml"));
  assert.match(ok.text, /file notes.md/);

  const mixed = loadSkillFileViews(skills, "handoff", [
    "notes.md",
    "../secret.env",
  ]);
  assert.equal(mixed.views.length, 1);
  assert.equal(mixed.errors.length, 1);
  assert.match(mixed.text, /# error:/);
  assert.match(mixed.errors[0], /escapes/);

  const many = Array.from(
    { length: MAX_FILE_VIEW_FILES + 2 },
    (_, i) => `notes.md`,
  );
  const capped = normalizeSkillFileList(many);
  assert.equal(capped.files.length, 1);

  const over = normalizeSkillFileList(
    Array.from({ length: MAX_FILE_VIEW_FILES + 1 }, (_, i) => `f${i}.md`),
  );
  assert.equal(over.files.length, MAX_FILE_VIEW_FILES);
  assert.match(over.note ?? "", /first 10/);
});

test("loadSkillView includes sibling names on the first SKILL.md window", () => {
  const view = loadSkillView([handoff], "handoff", undefined, {
    includeSiblings: true,
  });
  assert.equal(view.ok, true);
  if (view.ok) {
    assert.match(view.text, /skill_file_view name=handoff files=/);
    assert.match(view.text, /files in skill directory:/);
  }
});

test("catalog tree merges directories and errors on the same skill path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-tree-"));
  const repo = path.join(root, ".pi", "skills");
  const host = path.join(root, ".agents", "skills");
  const write = (base: string, rel: string, body: string) => {
    const dir = path.join(base, rel);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), body);
  };
  write(repo, "a/b/c", "---\nname: c\ndescription: from repo\n---\n\nC\n");
  write(host, "a/b/d", "---\nname: d\ndescription: from host\n---\n\nD\n");
  fs.writeFileSync(
    path.join(repo, "a", "context.md"),
    "---\nsummary: group a\n---\n\nmore\n",
  );
  const skills: SkillRef[] = [
    {
      name: "c",
      description: "from repo",
      filePath: path.join(repo, "a/b/c/SKILL.md"),
      baseDir: path.join(repo, "a/b/c"),
    },
    {
      name: "d",
      description: "from host",
      filePath: path.join(host, "a/b/d/SKILL.md"),
      baseDir: path.join(host, "a/b/d"),
    },
  ];
  const tree = buildCatalogTree(skills, [repo, host]);
  assert.equal(tree.error, undefined);
  assert.equal(formatSkillTree(tree), "a/\n  b/\n    c\n    d");
  const top = listDirectory(tree, undefined);
  assert.equal(top.ok, true);
  if (top.ok) {
    const page = paginateList(top.entries);
    const text = formatDirectoryList(page.items, {
      path: top.path,
      header: top.header,
      from: page.from,
      to: page.to,
      total: page.total,
      remaining: page.remaining,
    });
    assert.match(text, /^- a\/  group a$/m);
  }
  const inside = listDirectory(tree, "a/b/c");
  assert.equal(inside.ok, false);
  if (!inside.ok) assert.match(inside.error, /skill_view with name=a\/b\/c/);

  write(host, "a/b/c", "---\nname: c\ndescription: clash\n---\n\n");
  const clash = buildCatalogTree(
    [
      ...skills,
      {
        name: "c",
        description: "clash",
        filePath: path.join(host, "a/b/c/SKILL.md"),
        baseDir: path.join(host, "a/b/c"),
      },
    ],
    [repo, host],
  );
  assert.match(clash.error ?? "", /two skills are loaded at a\/b\/c/i);

  const long = "x".repeat(250);
  const trimmed = directoryBlurb(`---\nname: n\n---\n\n${long}\n`);
  assert.equal(trimmed.trimmed, true);
  assert.equal(trimmed.text.length, 200);
});
