import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import type { SkillRef } from "./lib.ts";
import { searchSkills } from "./search.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-search-"));

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(name: string, files: Record<string, string>): SkillRef {
  const baseDir = path.join(tmp, name);
  fs.mkdirSync(baseDir, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return {
    name,
    description: files["SKILL.md"]?.slice(0, 80) ?? name,
    filePath: path.join(baseDir, "SKILL.md"),
    baseDir,
  };
}

test("searchSkills fuzzy-matches skill names and file bodies", () => {
  const handoff = writeSkill("handoff", {
    "SKILL.md":
      "---\nname: handoff\n---\nWrite a handoff document for the next agent.\n",
    "notes.md": "Suggested skills live in this folder.\n",
  });
  const clone = writeSkill("clone-repo", {
    "SKILL.md":
      "---\nname: clone-repo\n---\nClone Azure DevOps and Cloud Source repos.\n",
    "recipes.md": "composer.lock must exist on the branch.\n",
  });

  const byName = searchSkills([handoff, clone], "handoff");
  assert.ok(byName.some((h) => h.skill === "handoff" && h.file === "SKILL.md"));
  assert.ok(!byName.some((h) => h.skill === "handoff" && h.file === "notes.md"));

  const byBody = searchSkills([handoff, clone], "composer.lock");
  assert.ok(
    byBody.some((h) => h.skill === "clone-repo" && h.file === "recipes.md"),
  );
  assert.match(byBody[0].snippet, /composer\.lock/);

  const fuzzy = searchSkills([handoff, clone], "handof");
  assert.ok(fuzzy.some((h) => h.skill === "handoff"));
});
