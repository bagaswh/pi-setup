import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  manageCreate,
  manageDelete,
  managePatch,
  manageRemoveFile,
  manageWriteFile,
  skillRefFromDisk,
  skillToolsActive,
  type SkillRef,
} from "./lib.ts";

// os.homedir is used lazily by manageRoot(); point HOME-equivalent at a temp
// dir by monkeypatching os.homedir for the duration of this test file.
const REAL_HOME = os.homedir();
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-manage-"));

before(() => {
  os.homedir = () => tmpRoot;
});
after(() => {
  os.homedir = () => REAL_HOME;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const SKILL_MD = `---
name: test-skill
summary: Testing skill_manage
description: A test skill.
---

# Test Skill

Body line one.
Body line two.
`;

function makeCatalog(): SkillRef[] {
  const baseDir = path.join(tmpRoot, ".agents", "skills", "test-skill");
  return [
    {
      name: "test-skill",
      description: "A test skill.",
      filePath: path.join(baseDir, "SKILL.md"),
      baseDir,
    },
  ];
}

test("manageCreate writes a valid new skill", () => {
  const res = manageCreate("test-skill", SKILL_MD);
  assert.ok(res.ok);
  assert.equal(path.basename(res.baseDir), "test-skill");
  assert.match(fs.readFileSync(res.filePath, "utf8"), /name: test-skill/);
});

test("manageCreate rejects a bad name", () => {
  const res = manageCreate("Bad_Name", SKILL_MD);
  assert.ok(!res.ok);
  assert.match(res.error, /does not match/);
});

test("manageCreate rejects frontmatter-name mismatch", () => {
  const res = manageCreate("other-skill", SKILL_MD);
  assert.ok(!res.ok);
  assert.match(res.error, /does not match the skill name/);
});

test("manageCreate rejects missing frontmatter", () => {
  const res = manageCreate("test-skill", "# no frontmatter\n");
  assert.ok(!res.ok);
  assert.match(res.error, /frontmatter/i);
});

test("manageCreate refuses to overwrite an existing skill", () => {
  const res = manageCreate("test-skill", SKILL_MD);
  assert.ok(!res.ok);
  assert.match(res.error, /already exists/);
});

test("manageCreate rejects a missing description", () => {
  fs.mkdirSync(path.join(tmpRoot, ".agents", "skills"), { recursive: true });
  const res = manageCreate(
    "nodesc-skill",
    "---\nname: nodesc-skill\n---\n\nbody\n",
  );
  assert.ok(!res.ok);
  assert.match(res.error, /description/);
});

test("managePatch replaces a unique string and revalidates frontmatter", () => {
  const res = managePatch(makeCatalog(), "test-skill", "Body line one.", "Body line uno.");
  assert.ok(res.ok);
  assert.match(res.content, /Body line uno\./);
  // frontmatter must survive intact
  assert.match(res.content, /name: test-skill/);
});

test("managePatch fails on no match", () => {
  const res = managePatch(makeCatalog(), "test-skill", "no such text", "x");
  assert.ok(!res.ok);
  assert.match(res.error, /not found/);
});

test("managePatch fails on ambiguous match", () => {
  const res = managePatch(makeCatalog(), "test-skill", "Body line", "X");
  assert.ok(!res.ok);
  assert.match(res.error, /matches 2 places/);
});

test("managePatch fails on unknown skill", () => {
  const res = managePatch(makeCatalog(), "nope-skill", "a", "b");
  assert.ok(!res.ok);
  assert.match(res.error, /Unknown skill/);
});

test("managePatch refuses skills outside the manage root", () => {
  const outside = path.join(tmpRoot, "elsewhere", "ext-skill");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "SKILL.md"), SKILL_MD);
  const catalog: SkillRef[] = [
    {
      name: "ext-skill",
      description: "d",
      filePath: path.join(outside, "SKILL.md"),
      baseDir: outside,
    },
  ];
  const res = managePatch(catalog, "ext-skill", "Body line one.", "x");
  assert.ok(!res.ok);
  assert.match(res.error, /outside/);
});

test("manageWriteFile writes a companion file", () => {
  const res = manageWriteFile(
    makeCatalog(),
    "test-skill",
    "references/table.md",
    "| a | b |\n",
  );
  assert.ok(res.ok);
  assert.ok(fs.existsSync(res.absPath));
});

test("manageWriteFile rejects SKILL.md and escapes", () => {
  assert.ok(!manageWriteFile(makeCatalog(), "test-skill", "SKILL.md", "x").ok);
  assert.ok(
    !manageWriteFile(makeCatalog(), "test-skill", "../escape.md", "x").ok,
  );
});

test("manageRemoveFile removes a file and prunes empty dirs", () => {
  const res = manageRemoveFile(makeCatalog(), "test-skill", "references/table.md");
  assert.ok(res.ok);
  assert.ok(!fs.existsSync(path.join(makeCatalog()[0].baseDir, "references")));
});

test("manageRemoveFile refuses SKILL.md", () => {
  const res = manageRemoveFile(makeCatalog(), "test-skill", "SKILL.md");
  assert.ok(!res.ok);
  assert.match(res.error, /delete/);
});

test("manageDelete removes the skill directory", () => {
  const res = manageDelete(makeCatalog(), "test-skill");
  assert.ok(res.ok);
  assert.ok(!fs.existsSync(res.baseDir));
});

test("skillRefFromDisk reads name and description back", () => {
  const baseDir = path.join(tmpRoot, ".agents", "skills", "ref-skill");
  fs.mkdirSync(path.join(baseDir), { recursive: true });
  fs.writeFileSync(
    path.join(baseDir, "SKILL.md"),
    "---\nname: ref-skill\ndescription: refd\n---\n\nbody\n",
  );
  const res = skillRefFromDisk(baseDir);
  assert.ok(res.ok);
  assert.equal(res.ref.name, "ref-skill");
  assert.equal(res.ref.description, "refd");
});

test("skillToolsActive recognizes skill_manage", () => {
  assert.ok(skillToolsActive(["skill_manage"]));
});
