import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  applyTextEdits,
  editSkillFile,
  prepareSkillEditArguments,
  skillToolsActive,
  type SkillRef,
} from "./lib.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-edit-"));
const skillDir = path.join(tmp, "elsewhere", "demo-skill");

const SKILL_MD = `---
name: demo-skill
summary: Demo
description: A demo skill.
---

# Demo

Alpha line.
Beta line.
Gamma line.
`;

const NOTES = "notes start\nkeep me\nnotes end\n";

const demo: SkillRef = {
  name: "demo-skill",
  description: "A demo skill.",
  filePath: path.join(skillDir, "SKILL.md"),
  baseDir: skillDir,
};

before(() => {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(demo.filePath, SKILL_MD);
  fs.writeFileSync(path.join(skillDir, "notes.md"), NOTES);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("applyTextEdits replaces several unique regions", () => {
  const got = applyTextEdits(SKILL_MD, [
    { oldText: "Alpha line.", newText: "ALPHA." },
    { oldText: "Gamma line.", newText: "GAMMA." },
  ]);
  assert.ok(got.ok);
  assert.match(got.content, /ALPHA\./);
  assert.match(got.content, /Beta line\./);
  assert.match(got.content, /GAMMA\./);
});

test("applyTextEdits rejects missing, ambiguous, overlapping, and empty oldText", () => {
  const missing = applyTextEdits(SKILL_MD, [{ oldText: "nope", newText: "x" }]);
  assert.ok(!missing.ok);
  assert.match(missing.error, /Could not find/);

  const many = applyTextEdits("aa aa", [{ oldText: "aa", newText: "b" }]);
  assert.ok(!many.ok);
  assert.match(many.error, /2 occurrences/);

  const overlap = applyTextEdits(SKILL_MD, [
    { oldText: "Alpha line.\nBeta", newText: "X" },
    { oldText: "Beta line.", newText: "Y" },
  ]);
  assert.ok(!overlap.ok);
  assert.match(overlap.error, /overlap/);

  const empty = applyTextEdits(SKILL_MD, [{ oldText: "", newText: "x" }]);
  assert.ok(!empty.ok);
  assert.match(empty.error, /empty/);
});

test("editSkillFile patches a loaded skill outside ~/.agents/skills", () => {
  const res = editSkillFile(catalog(), "demo-skill", "SKILL.md", [
    { oldText: "Alpha line.", newText: "Alpha patched." },
  ]);
  assert.ok(res.ok);
  assert.match(fs.readFileSync(demo.filePath, "utf8"), /Alpha patched\./);
  assert.ok(!res.absPath.includes(`${path.sep}.agents${path.sep}skills`));
});

test("editSkillFile rejects a frontmatter-breaking SKILL.md patch", () => {
  const res = editSkillFile(catalog(), "demo-skill", "SKILL.md", [
    { oldText: "name: demo-skill", newText: "name: other-name" },
  ]);
  assert.ok(!res.ok);
  assert.match(res.error, /does not match the skill name/);
});

test("editSkillFile patches companion files and refuses escapes", () => {
  const ok = editSkillFile(catalog(), "demo-skill", "notes.md", [
    { oldText: "keep me", newText: "kept" },
  ]);
  assert.ok(ok.ok);
  assert.match(fs.readFileSync(path.join(skillDir, "notes.md"), "utf8"), /kept/);

  const escape = editSkillFile(catalog(), "demo-skill", "../secret.md", [
    { oldText: "a", newText: "b" },
  ]);
  assert.ok(!escape.ok);
  assert.match(escape.error, /escapes|not found|Unknown/);
});

test("prepareSkillEditArguments accepts Pi edit shapes", () => {
  assert.deepEqual(
    prepareSkillEditArguments({
      name: "demo-skill",
      edits: JSON.stringify([{ oldText: "a", newText: "b" }]),
    }).edits,
    [{ oldText: "a", newText: "b" }],
  );
  assert.deepEqual(
    prepareSkillEditArguments({ edits: { oldText: "a", newText: "b" } }).edits,
    [{ oldText: "a", newText: "b" }],
  );
  assert.deepEqual(
    prepareSkillEditArguments({ oldText: "a", newText: "b" }).edits,
    [{ oldText: "a", newText: "b" }],
  );
});

test("skillToolsActive recognizes skill_edit and skill_file_edit", () => {
  assert.ok(skillToolsActive(["skill_edit"]));
  assert.ok(skillToolsActive(["skill_file_edit"]));
  assert.equal(skillToolsActive(["read", "bash"]), false);
});

function catalog(): SkillRef[] {
  return [
    {
      name: "demo-skill",
      description: "A demo skill.",
      filePath: demo.filePath,
      baseDir: skillDir,
    },
  ];
}
