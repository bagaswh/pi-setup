/**
 * MiniSearch index over Pi's loaded skills.
 *
 * One document per text file under a skill directory. Skill name and
 * description are searchable only on SKILL.md so a name query does not
 * repeat every companion file.
 */

import MiniSearch from "minisearch";

import {
  readSkillFile,
  skillId,
  snippetAround,
  walkSkillTextFiles,
  type SkillRef,
  type SkillSearchHit,
} from "./lib.ts";

type IndexedDoc = {
  id: string;
  skill: string;
  file: string;
  title: string;
  description: string;
  content: string;
};

function collectDocs(skills: SkillRef[]): IndexedDoc[] {
  const docs: IndexedDoc[] = [];
  for (const skill of skills) {
    for (const file of walkSkillTextFiles(skill)) {
      const read = readSkillFile(file.absPath);
      if (!read.ok) continue;
      const isRoot = file.relPath === "SKILL.md";
      docs.push({
        id: `${skillId(skill)}:${file.relPath}`,
        skill: skillId(skill),
        file: file.relPath,
        title: isRoot ? skillId(skill) : file.relPath,
        description: isRoot ? skill.description : "",
        content: read.content,
      });
    }
  }
  return docs;
}

export function searchSkills(
  skills: SkillRef[],
  searchTerm: string,
): SkillSearchHit[] {
  const term = searchTerm.trim();
  if (!term) return [];
  const docs = collectDocs(skills);
  if (docs.length === 0) return [];

  const mini = new MiniSearch<IndexedDoc>({
    fields: ["title", "file", "description", "content"],
    storeFields: ["skill", "file", "content"],
    searchOptions: {
      boost: { title: 5, file: 3, description: 2, content: 1 },
      prefix: true,
      fuzzy: (t: string) => (t.length > 3 ? 0.2 : false),
    },
  });
  mini.addAll(docs);

  return mini.search(term).map((result) => ({
    skill: String(result.skill),
    file: String(result.file),
    score: result.score,
    snippet: snippetAround(String(result.content ?? ""), term),
  }));
}
