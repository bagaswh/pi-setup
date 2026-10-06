/**
 * Host-side skill catalog helpers for the skill_view extension.
 *
 * Pi has no skill_view tool. It lists host paths in <available_skills> and
 * tells the model to `read` / `bash` them. Gondolin remaps those tools into
 * the VM, so global skills (~/.agents/skills, ~/.pi/agent/skills) and the
 * repo's .pi/skills (outside workspace/) are invisible. This module resolves
 * names against the catalog Pi already loaded and reads only files inside a
 * skill directory.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SKILL_VIEW_READ_HINT =
  "Use the skill_view tool to load a skill when the task matches its description.";

export const SKILL_VIEW_RELATIVE_HINT =
  "When a skill file references a relative path, call skill_file_view with that skill name and files set to the relative paths.";

const PI_READ_HINT =
  "Use the read tool to load a skill's file when the task matches its description.";
const PI_BASH_HINT =
  "Use bash to load a skill's file when the task matches its description.";
const PI_RELATIVE_HINT =
  "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.";

const MAX_BYTES = 512 * 1024;

export const DEFAULT_LIST_LIMIT = 20;
export const MAX_LIST_LIMIT = 40;
export const DEFAULT_VIEW_LINES = 80;
export const MAX_VIEW_LINES = 200;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;
export const MAX_FILE_VIEW_FILES = 10;

export interface SkillRef {
  name: string;
  description: string;
  summary?: string;
  filePath: string;
  baseDir: string;
  /** Catalog-relative path (`clone-repo`, `a/b/c`). Lookup key for skill tools. */
  catalogPath?: string;
  disableModelInvocation?: boolean;
}

export function skillId(skill: SkillRef): string {
  return skill.catalogPath ?? skill.name;
}

export type ResolveOk = {
  ok: true;
  skill: SkillRef;
  absPath: string;
  relPath: string;
};

export type ResolveErr = {
  ok: false;
  error: string;
};

export function isLexicallyInside(root: string, target: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function normalizeSkillName(raw: string): string {
  let name = raw.trim();
  if (name.startsWith("/skill:")) name = name.slice(7).trim();
  else if (name.startsWith("skill:")) name = name.slice(6).trim();
  const space = name.indexOf(" ");
  if (space !== -1) name = name.slice(0, space);
  return name;
}

export function findSkill(
  skills: SkillRef[],
  name: string,
): { skill: SkillRef; pathHint?: string } | undefined {
  const normalized = normalizeSkillName(name);
  if (!normalized) return undefined;

  const byName = skills.find((s) => skillId(s) === normalized);
  if (byName) return { skill: byName };

  const resolved = path.resolve(normalized);
  const byFile = skills.find(
    (s) => path.resolve(s.filePath) === resolved,
  );
  if (byFile) return { skill: byFile, pathHint: path.basename(resolved) };

  const byDir = skills.find((s) =>
    isLexicallyInside(s.baseDir, resolved),
  );
  if (byDir) {
    return {
      skill: byDir,
      pathHint: path.relative(path.resolve(byDir.baseDir), resolved),
    };
  }
  return undefined;
}

export function clampInt(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value == null || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

export function paginateList<T>(
  items: T[],
  offset?: number,
  limit?: number,
): {
  items: T[];
  offset: number;
  limit: number;
  from: number;
  to: number;
  total: number;
  remaining: number;
} {
  const total = items.length;
  const lim = clampInt(limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT);
  const off = clampInt(offset, 0, 0, Number.MAX_SAFE_INTEGER);
  if (total === 0) {
    return {
      items: [],
      offset: 0,
      limit: lim,
      from: 0,
      to: 0,
      total: 0,
      remaining: 0,
    };
  }
  if (off >= total) {
    return {
      items: [],
      offset: off,
      limit: lim,
      from: 0,
      to: 0,
      total,
      remaining: 0,
    };
  }
  const slice = items.slice(off, off + lim);
  const from = off;
  const to = off + slice.length - 1;
  return {
    items: slice,
    offset: off,
    limit: lim,
    from,
    to,
    total,
    remaining: total - (to + 1),
  };
}

export function splitLines(content: string): string[] {
  if (content === "") return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function parseLoadFull(frontmatter: string | undefined): boolean {
  if (!frontmatter) return false;
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^(?:load-full|always-load-full)\s*:\s*(.+?)\s*$/i);
    if (!match) continue;
    const value = match[1].toLowerCase();
    return value === "true" || value === "yes" || value === "1";
  }
  return false;
}

/**
 * Parse an <available_skills> block out of a system prompt.
 *
 * pi-subagents children launch with noSkills, so the plugin injects the
 * frontmatter `skills:` selection into the child prompt as an
 * <available_skills> block (name/description/location) instead of loading
 * the skills natively. This fallback turns that block back into a catalog
 * so the skill tools keep working in children. Only <skill> entries inside
 * the block are read; nothing else in the prompt is touched.
 */
export function parseAvailableSkillsBlock(
  systemPrompt: string,
): SkillRef[] {
  const start = systemPrompt.indexOf("<available_skills>");
  if (start === -1) return [];
  const end = systemPrompt.indexOf("</available_skills>", start);
  if (end === -1) return [];
  const block = systemPrompt.slice(start, end);
  const entries = block.match(/<skill>[\s\S]*?<\/skill>/g) ?? [];
  const refs: SkillRef[] = [];
  for (const entry of entries) {
    const name = entry.match(/<name>([^<]*)<\/name>/)?.[1]?.trim();
    const description = entry
      .match(/<description>([\s\S]*?)<\/description>/)?.[1]
      ?.trim();
    const location = entry.match(/<location>([^<]*)<\/location>/)?.[1]?.trim();
    if (!name || !location) continue;
    const baseDir = path.dirname(location);
    if (!baseDir || baseDir === "." || baseDir === "/") continue;
    refs.push({
      name,
      description: description ?? "",
      filePath: location,
      baseDir,
    });
  }
  return refs;
}

/**
 * Read a simple scalar value out of a YAML frontmatter string.
 * Matches `key: value` lines at the top level (no indentation), strips
 * surrounding quotes. Returns undefined when the key is absent.
 */
export function pickFrontmatterValue(
  frontmatter: string | undefined,
  key: string,
): string | undefined {
  if (!frontmatter) return undefined;
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+?)\\s*$`,
  );
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) continue;
    const value = match[1];
    const quoted = value.match(/^"([\s\S]*)"$|^'([\s\S]*)'$/);
    return quoted ? (quoted[1] ?? quoted[2]) : value;
  }
  return undefined;
}

/**
 * Read the `summary` frontmatter field from a skill's SKILL.md.
 * Returns undefined when the file cannot be read or the field is absent.
 */
export function readSummary(skill: SkillRef): string | undefined {
  try {
    const read = readSkillFile(skill.filePath);
    if (!read.ok) return undefined;
    return pickFrontmatterValue(extractFrontmatter(read.content), "summary");
  } catch {
    return undefined;
  }
}

export function clampLineWindow(opts: {
  total: number;
  from?: number;
  to?: number;
  loadFull?: boolean;
}): { from: number; to: number; remaining: number; total: number } {
  const total = Math.max(0, opts.total);
  if (total === 0) {
    return { from: 0, to: 0, remaining: 0, total: 0 };
  }
  const fromSpecified = opts.from != null;
  const toSpecified = opts.to != null;
  if (!fromSpecified && !toSpecified && (opts.loadFull || total <= MAX_VIEW_LINES)) {
    return { from: 0, to: total - 1, remaining: 0, total };
  }
  const from = clampInt(opts.from, 0, 0, total - 1);
  let to =
    opts.to == null
      ? from + DEFAULT_VIEW_LINES - 1
      : Math.floor(opts.to);
  if (!Number.isFinite(to)) to = from + DEFAULT_VIEW_LINES - 1;
  if (to < from) to = from;
  if (to - from + 1 > MAX_VIEW_LINES) to = from + MAX_VIEW_LINES - 1;
  if (to > total - 1) to = total - 1;
  return { from, to, remaining: total - (to + 1), total };
}

export function sliceLineWindow(
  content: string,
  from: number,
  to: number,
): string {
  if (from < 0 || to < from) return "";
  return splitLines(content).slice(from, to + 1).join("\n");
}

export function resolveSkillFile(
  skills: SkillRef[],
  name: string,
  file?: string,
): ResolveOk | ResolveErr {
  const found = findSkill(skills, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Call skill_list to see available names.`,
    };
  }

  const relPath = (file?.trim() || found.pathHint || "SKILL.md").replace(
    /^[/\\]+/,
    "",
  );
  if (!relPath) {
    return { ok: false, error: "file path is empty" };
  }

  const absPath = path.resolve(found.skill.baseDir, relPath);
  if (!isLexicallyInside(found.skill.baseDir, absPath)) {
    return {
      ok: false,
      error: `file ${JSON.stringify(relPath)} escapes skill directory ${found.skill.name}`,
    };
  }

  if (!fs.existsSync(absPath)) {
    return {
      ok: false,
      error: `file ${JSON.stringify(relPath)} not found in skill ${found.skill.name}`,
    };
  }

  let realFile: string;
  let realRoot: string;
  try {
    realFile = fs.realpathSync(absPath);
    realRoot = fs.realpathSync(found.skill.baseDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `cannot read ${JSON.stringify(relPath)}: ${message}` };
  }
  if (!isLexicallyInside(realRoot, realFile)) {
    return {
      ok: false,
      error: `file ${JSON.stringify(relPath)} escapes skill directory ${found.skill.name}`,
    };
  }

  const stat = fs.statSync(realFile);
  if (!stat.isFile()) {
    return {
      ok: false,
      error: `${JSON.stringify(relPath)} is not a file in skill ${found.skill.name}`,
    };
  }

  return {
    ok: true,
    skill: found.skill,
    absPath: realFile,
    relPath: path.relative(realRoot, realFile) || path.basename(realFile),
  };
}

export function listSkillFiles(baseDir: string, limit = 30): string[] {
  try {
    return fs
      .readdirSync(baseDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .slice(0, limit);
  } catch {
    return [];
  }
}

const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".bin",
  ".wasm",
  ".so",
  ".dylib",
  ".exe",
]);

export type SkillTextFile = {
  relPath: string;
  absPath: string;
};

export function walkSkillTextFiles(skill: SkillRef): SkillTextFile[] {
  const out: SkillTextFile[] = [];
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(skill.baseDir);
  } catch {
    return out;
  }

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (!isLexicallyInside(rootReal, abs)) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(abs);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (SKIP_EXT.has(ext)) continue;
      let realFile: string;
      try {
        realFile = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (!isLexicallyInside(rootReal, realFile)) continue;
      try {
        if (!fs.statSync(realFile).isFile()) continue;
      } catch {
        continue;
      }
      out.push({
        relPath: path.relative(rootReal, realFile) || path.basename(realFile),
        absPath: realFile,
      });
    }
  };

  walk(rootReal);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

export function snippetAround(
  content: string,
  query: string,
  radius = 90,
): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 2);
  const lower = compact.toLowerCase();
  let idx = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (idx === -1 || found < idx)) idx = found;
  }
  if (idx === -1) {
    return compact.length > radius * 2
      ? `${compact.slice(0, radius * 2)}…`
      : compact;
  }
  const start = Math.max(0, idx - radius);
  const end = Math.min(compact.length, idx + radius);
  const slice = compact.slice(start, end);
  return `${start > 0 ? "…" : ""}${slice}${end < compact.length ? "…" : ""}`;
}

export type SkillSearchHit = {
  skill: string;
  file: string;
  score: number;
  snippet: string;
  alreadyLoaded?: boolean;
};

export function formatSearchHits(
  hits: SkillSearchHit[],
  opts: {
    searchTerm: string;
    from?: number;
    to?: number;
    total?: number;
    remaining?: number;
    offset?: number;
  },
): string {
  const total = opts.total ?? hits.length;
  const from = opts.from ?? 0;
  const to = opts.to ?? Math.max(0, hits.length - 1);
  const remaining = opts.remaining ?? Math.max(0, total - (to + 1));
  const term = opts.searchTerm;

  if (total === 0) {
    return `No matches for ${JSON.stringify(term)}.`;
  }

  const lines = [
    `Search ${JSON.stringify(term)} (printed ${from} to ${to} of ${total}, remaining ${remaining}):`,
    "",
  ];

  if (hits.length === 0) {
    const lastOffset = Math.max(0, total - DEFAULT_SEARCH_LIMIT);
    lines.push(
      `offset ${opts.offset ?? 0} is past the end. Call skill_search with searchTerm=${JSON.stringify(term)} offset=${lastOffset} for the last page.`,
    );
    return lines.join("\n");
  }

  for (const hit of hits) {
    const loadHint =
      hit.file === "SKILL.md"
        ? `Call skill_view with name=${hit.skill} to load this file.`
        : `Call skill_file_view with name=${hit.skill} files=[${hit.file}] to load this file.`;
    const loaded = hit.alreadyLoaded
      ? "  [already loaded in this conversation]"
      : "";
    lines.push(
      `- ${hit.skill}  ${hit.file}  score ${hit.score.toFixed(1)}${loaded}`,
    );
    if (hit.snippet) lines.push(`  ${hit.snippet}`);
    lines.push(`  ${loadHint}`);
    lines.push("");
  }
  if (hits.some((h) => h.alreadyLoaded)) {
    lines.push(
      "[already loaded] marks a hit whose file window is already in this conversation as-is. After context compression, call skill_view with forceView=true to re-load.",
    );
    lines.push("");
  }
  if (remaining > 0) {
    lines.push(
      `Call skill_search with searchTerm=${JSON.stringify(term)} offset=${to + 1} to continue.`,
    );
  }
  return lines.join("\n");
}

export function extractFrontmatter(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match ? match[1].trimEnd() : undefined;
}

export function formatSkillList(
  skills: SkillRef[],
  opts?: {
    printSummary?: boolean;
    printDescription?: boolean;
    from?: number;
    to?: number;
    total?: number;
    remaining?: number;
    offset?: number;
  },
): string {
  const total = opts?.total ?? skills.length;
  const from = opts?.from ?? 0;
  const to = opts?.to ?? Math.max(0, skills.length - 1);
  const remaining = opts?.remaining ?? Math.max(0, total - (to + 1));
  const printSummary = opts?.printSummary === true;
  const printDescription = opts?.printDescription === true;

  if (total === 0) {
    return "No skills loaded.";
  }

  const lines = [
    `Available skills (printed ${from} to ${to} of ${total}, remaining ${remaining}):`,
    "",
  ];

  if (skills.length === 0) {
    const lastOffset = Math.max(0, total - DEFAULT_LIST_LIMIT);
    lines.push(
      `offset ${opts?.offset ?? 0} is past the end. Call skill_list with offset=${lastOffset} for the last page.`,
    );
    return lines.join("\n");
  }

  for (const skill of skills) {
    const tag = skill.disableModelInvocation ? " [slash-only]" : "";
    if (printSummary) {
      const desc = (skill.summary ?? skill.description)
        .replace(/\s+/g, " ")
        .trim();
      lines.push(`- ${skill.name}${tag}: ${desc}`);
    } else if (printDescription) {
      const desc = skill.description.replace(/\s+/g, " ").trim();
      lines.push(`- ${skill.name}${tag}: ${desc}`);
    } else {
      lines.push(`- ${skill.name}${tag}`);
    }
  }
  lines.push("");
  lines.push(
    "Names only unless printSummary or printDescription is true. printSummary prints the summary frontmatter field, falling back to description. printDescription always prints the full description. Call skill_read_frontmatter with name=<skill> for YAML frontmatter. Call skill_view with name=<skill> to load instructions. Slash-only skills are hidden from the system prompt; the user invokes them with /skill:name.",
  );
  if (remaining > 0) {
    const extra = printSummary
      ? " printSummary=true"
      : printDescription
        ? " printDescription=true"
        : "";
    lines.push(`Call skill_list with offset=${to + 1}${extra} to continue.`);
  }
  return lines.join("\n");
}

export function formatSkillFrontmatter(opts: {
  skill: SkillRef;
  frontmatter?: string;
}): string {
  const id = skillId(opts.skill);
  const lines = [`# skill ${id}  frontmatter`];
  if (opts.frontmatter !== undefined && opts.frontmatter !== "") {
    lines.push("---");
    lines.push(opts.frontmatter);
    lines.push("---");
  } else {
    lines.push("(no frontmatter)");
  }
  lines.push("");
  if (parseLoadFull(opts.frontmatter)) {
    lines.push(
      `load-full is set. Call skill_view with name=${id} to load the whole file.`,
    );
  } else {
    lines.push(
      `Call skill_view with name=${id} to load instructions.`,
    );
  }
  return lines.join("\n");
}

export function formatSkillFile(opts: {
  skill: SkillRef;
  relPath: string;
  content: string;
  from: number;
  to: number;
  remaining: number;
  total: number;
  siblings?: string[];
}): string {
  const nextFrom = opts.to + 1;
  const nextTo = Math.min(nextFrom + DEFAULT_VIEW_LINES - 1, opts.total - 1);
  const id = skillId(opts.skill);
  const fileArg =
    opts.relPath === "SKILL.md" ? "" : ` file=${opts.relPath}`;
  const lines = [
    `# skill ${id}  file ${opts.relPath}  (printed from line ${opts.from} to line ${opts.to}, remaining ${opts.remaining} lines)`,
  ];
  if (opts.from === 0) {
    lines.push(
      `# companion files: skill_file_view name=${id} files=[<relative paths>]`,
    );
    if (opts.siblings && opts.siblings.length > 0) {
      lines.push(`# files in skill directory: ${opts.siblings.join(", ")}`);
    }
  }
  if (opts.remaining > 0) {
    lines.push(
      `# Call skill_view with name=${id}${fileArg} from=${nextFrom} to=${nextTo} to load the next window.`,
    );
  }
  lines.push("");
  lines.push(opts.content);
  return lines.join("\n");
}

export function readSkillFile(absPath: string): { ok: true; content: string } | ResolveErr {
  const stat = fs.statSync(absPath);
  if (stat.size > MAX_BYTES) {
    return {
      ok: false,
      error: `file is ${stat.size} bytes; skill_view limit is ${MAX_BYTES}`,
    };
  }
  const buf = fs.readFileSync(absPath);
  if (buf.includes(0)) {
    return { ok: false, error: "file is binary; skill_view reads text only" };
  }
  return { ok: true, content: buf.toString("utf8") };
}

export type SkillViewOk = {
  ok: true;
  text: string;
  skill: SkillRef;
  relPath: string;
  from: number;
  to: number;
  remaining: number;
  total: number;
};

export function loadSkillView(
  skills: SkillRef[],
  name: string,
  file?: string,
  opts?: { from?: number; to?: number; includeSiblings?: boolean },
): SkillViewOk | ResolveErr {
  const resolved = resolveSkillFile(skills, name, file);
  if (!resolved.ok) return resolved;
  const read = readSkillFile(resolved.absPath);
  if (!read.ok) return read;
  const window = clampLineWindow({
    total: splitLines(read.content).length,
    from: opts?.from,
    to: opts?.to,
    loadFull:
      resolved.relPath === "SKILL.md" &&
      parseLoadFull(extractFrontmatter(read.content)),
  });
  const siblings =
    opts?.includeSiblings &&
    resolved.relPath === "SKILL.md" &&
    window.from === 0
      ? listSkillFiles(resolved.skill.baseDir)
      : undefined;
  return {
    ok: true,
    text: formatSkillFile({
      skill: resolved.skill,
      relPath: resolved.relPath,
      content: sliceLineWindow(read.content, window.from, window.to),
      from: window.from,
      to: window.to,
      remaining: window.remaining,
      total: window.total,
      siblings,
    }),
    skill: resolved.skill,
    relPath: resolved.relPath,
    from: window.from,
    to: window.to,
    remaining: window.remaining,
    total: window.total,
  };
}

export function normalizeSkillFileList(files: string[]): {
  files: string[];
  note?: string;
  error?: string;
} {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of files) {
    const rel = raw.trim().replace(/^[/\\]+/, "");
    if (!rel) continue;
    const key = rel.replaceAll("\\", "/");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  if (out.length === 0) {
    return {
      files: [],
      error:
        "files is empty. Pass relative paths under the skill directory, for example references.md.",
    };
  }
  if (out.length > MAX_FILE_VIEW_FILES) {
    return {
      files: out.slice(0, MAX_FILE_VIEW_FILES),
      note: `files has ${out.length} entries; printing the first ${MAX_FILE_VIEW_FILES}. Call skill_file_view again with the rest.`,
    };
  }
  return { files: out };
}

export function loadSkillFileViews(
  skills: SkillRef[],
  name: string,
  files: string[],
): { text: string; errors: string[]; views: SkillViewOk[] } {
  const found = findSkill(skills, name);
  if (!found) {
    const error = `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Call skill_list to see available names.`;
    return { text: error, errors: [error], views: [] };
  }
  const norm = normalizeSkillFileList(files);
  if (norm.error) {
    return { text: norm.error, errors: [norm.error], views: [] };
  }
  const parts: string[] = [];
  const errors: string[] = [];
  const views: SkillViewOk[] = [];
  if (norm.note) parts.push(norm.note);
  for (const file of norm.files) {
    const view = loadSkillView(skills, skillId(found.skill), file);
    if (!view.ok) {
      errors.push(view.error);
      parts.push(`# error: ${view.error}`);
      continue;
    }
    views.push(view);
    parts.push(view.text);
  }
  return { text: parts.join("\n\n"), errors, views };
}

export function rewriteSkillsPrompt(systemPrompt: string): string {
  return systemPrompt
    .replaceAll(PI_READ_HINT, SKILL_VIEW_READ_HINT)
    .replaceAll(PI_BASH_HINT, SKILL_VIEW_READ_HINT)
    .replaceAll(PI_RELATIVE_HINT, SKILL_VIEW_RELATIVE_HINT)
    .replace(
      /(<skill>\s*<name>)([^<]*)(<\/name>\s*<description>[^]*?<\/description>\s*<location>)[^<]*(<\/location>)/g,
      `$1$2$3skill_view name="$2"$4`,
    );
}

export const SKILL_TOOLS_PROMPT_MARKER = "# Skill tools (host catalog)";

export function appendSkillToolsPrompt(
  systemPrompt: string,
  body: string,
): string {
  const text = body.trim();
  if (!text) return systemPrompt;
  if (systemPrompt.includes(SKILL_TOOLS_PROMPT_MARKER)) return systemPrompt;
  return systemPrompt ? `${systemPrompt}\n\n${text}` : text;
}

export function skillToolsActive(selectedTools: string[] | undefined): boolean {
  if (!selectedTools || selectedTools.length === 0) return true;
  return (
    selectedTools.includes("skill_view") ||
    selectedTools.includes("skill_list") ||
    selectedTools.includes("skill_read_frontmatter") ||
    selectedTools.includes("skill_read_summary") ||
    selectedTools.includes("skill_read_description") ||
    selectedTools.includes("skill_search") ||
    selectedTools.includes("skill_file_view") ||
    selectedTools.includes("skill_tree") ||
    selectedTools.includes("skill_view_directory_context") ||
    selectedTools.includes("skill_edit") ||
    selectedTools.includes("skill_file_edit") ||
    selectedTools.includes("skill_manage") ||
    selectedTools.includes("skill_find")
  );
}

const CONTEXT_BLURB_CHARS = 200;

export function defaultCatalogRoots(
  cwd: string = process.cwd(),
  home: string = os.homedir(),
): string[] {
  return [
    path.resolve(cwd, ".pi", "skills"),
    path.join(home, ".agents", "skills"),
  ];
}

export function catalogRelative(
  baseDir: string,
  roots: string[],
): string | undefined {
  const abs = path.resolve(baseDir);
  for (const root of roots) {
    const rel = path.relative(path.resolve(root), abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    return rel.split(path.sep).join("/");
  }
  return undefined;
}

export function directoryBlurb(content: string): { text: string; trimmed: boolean } {
  const frontmatter = extractFrontmatter(content);
  const summary = foldLine(pickFrontmatterValue(frontmatter, "summary"));
  if (summary) return { text: summary, trimmed: false };
  const description = foldLine(pickFrontmatterValue(frontmatter, "description"));
  if (description) return { text: description, trimmed: false };
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const flat = foldLine(body) ?? "";
  if (flat.length <= CONTEXT_BLURB_CHARS) return { text: flat, trimmed: false };
  return { text: flat.slice(0, CONTEXT_BLURB_CHARS), trimmed: true };
}

function foldLine(value: string | undefined): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  return text ? text : undefined;
}

export type SkillDirEntry = {
  kind: "dir" | "skill";
  segment: string;
  path: string;
  skill?: SkillRef;
  blurb?: string;
  trimmed?: boolean;
};

export type CatalogTree = {
  error?: string;
  skills: SkillRef[];
  entries: Map<string, SkillDirEntry[]>;
  skillPaths: Map<string, SkillRef>;
  dirBlurb: Map<string, { text: string; trimmed: boolean }>;
};

export function buildCatalogTree(
  skills: SkillRef[],
  roots: string[],
): CatalogTree {
  const empty: CatalogTree = {
    skills: [],
    entries: new Map([["", []]]),
    skillPaths: new Map(),
    dirBlurb: new Map(),
  };
  const placed = new Map<string, SkillRef>();
  const withPaths: SkillRef[] = [];
  for (const skill of skills) {
    const catalogPath = catalogRelative(skill.baseDir, roots) ?? skill.name;
    const prev = placed.get(catalogPath);
    if (prev && path.resolve(prev.filePath) !== path.resolve(skill.filePath)) {
      return {
        ...empty,
        error:
          `Two skills are loaded at ${catalogPath}: ${prev.filePath} and ${skill.filePath}`,
      };
    }
    if (!prev) {
      const next = { ...skill, catalogPath };
      placed.set(catalogPath, next);
      withPaths.push(next);
    }
  }

  const entries = new Map<string, SkillDirEntry[]>([["", []]]);
  const skillPaths = new Map<string, SkillRef>();
  const ensureDir = (dirPath: string) => {
    if (!entries.has(dirPath)) entries.set(dirPath, []);
  };
  for (const skill of withPaths) {
    const parts = skillId(skill).split("/").filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) {
      return { ...empty, error: `Skill path ${skillId(skill)} is not safe` };
    }
    let parent = "";
    for (let i = 0; i < parts.length; i++) {
      const segment = parts[i]!;
      const here = parent ? `${parent}/${segment}` : segment;
      const isSkill = i === parts.length - 1;
      const siblings = entries.get(parent)!;
      if (isSkill) {
        if (siblings.some((entry) => entry.segment === segment && entry.kind === "dir")) {
          return {
            ...empty,
            error: `${here} is both a skill and a directory`,
          };
        }
        if (!siblings.some((entry) => entry.segment === segment)) {
          siblings.push({ kind: "skill", segment, path: here, skill });
        }
        skillPaths.set(here, skill);
      } else {
        if (siblings.some((entry) => entry.segment === segment && entry.kind === "skill")) {
          return {
            ...empty,
            error: `${here} is both a skill and a directory`,
          };
        }
        if (!siblings.some((entry) => entry.segment === segment)) {
          siblings.push({ kind: "dir", segment, path: here });
        }
        ensureDir(here);
      }
      parent = here;
    }
  }
  for (const siblings of entries.values()) {
    siblings.sort((a, b) => a.segment.localeCompare(b.segment));
  }

  const dirBlurb = new Map<string, { text: string; trimmed: boolean }>();
  for (const dirPath of entries.keys()) {
    const files = contextFiles(roots, dirPath);
    if (files.length > 1) {
      return {
        ...empty,
        error: `Two context.md files for ${dirPath || "."}: ${files[0]} and ${files[1]}`,
      };
    }
    if (files.length === 0) continue;
    let content: string;
    try {
      content = fs.readFileSync(files[0]!, "utf8");
    } catch {
      continue;
    }
    const blurb = directoryBlurb(content);
    if (!blurb.text) continue;
    dirBlurb.set(dirPath, blurb);
    if (dirPath === "") continue;
    const parent = dirPath.includes("/") ? dirPath.slice(0, dirPath.lastIndexOf("/")) : "";
    const segment = dirPath.slice(parent.length === 0 ? 0 : parent.length + 1);
    const entry = entries.get(parent)?.find((item) => item.segment === segment);
    if (entry && entry.kind === "dir") {
      entry.blurb = blurb.text;
      entry.trimmed = blurb.trimmed;
    }
  }

  return { skills: withPaths, entries, skillPaths, dirBlurb };
}

function contextFiles(roots: string[], dirPath: string): string[] {
  const rel = dirPath ? dirPath.split("/") : [];
  const found: string[] = [];
  for (const root of roots) {
    const file = path.join(root, ...rel, "context.md");
    if (fs.existsSync(file) && fs.statSync(file).isFile()) found.push(file);
  }
  return found;
}

export function normalizeCatalogPath(raw: string | undefined): string {
  let name = (raw ?? "").trim().replaceAll("\\", "/");
  if (name === "." || name === "/") return "";
  name = name.replace(/^\/+|\/+$/g, "");
  return name;
}

export function formatContextPointer(
  dirPath: string,
  blurb: string,
  trimmed: boolean,
): string {
  if (!trimmed) return blurb;
  const name = dirPath === "" ? "." : dirPath;
  return `${blurb} (trimmed). Call skill_view_directory_context with name=${name} to read the file.`;
}

export function listDirectory(
  tree: CatalogTree,
  rawPath: string | undefined,
):
  | { ok: true; path: string; entries: SkillDirEntry[]; header?: { text: string; trimmed: boolean } }
  | { ok: false; error: string } {
  if (tree.error) return { ok: false, error: tree.error };
  const dirPath = normalizeCatalogPath(rawPath);
  if (dirPath.split("/").some((part) => part === "." || part === "..")) {
    return { ok: false, error: `Unknown path ${JSON.stringify(rawPath ?? "")}.` };
  }
  const skill = tree.skillPaths.get(dirPath);
  if (skill) {
    return {
      ok: false,
      error: `${dirPath} is a skill. Call skill_view with name=${dirPath}.`,
    };
  }
  if (!tree.entries.has(dirPath)) {
    return { ok: false, error: `Unknown path ${JSON.stringify(dirPath || rawPath || "")}.` };
  }
  const header = tree.dirBlurb.get(dirPath);
  return {
    ok: true,
    path: dirPath,
    entries: tree.entries.get(dirPath) ?? [],
    header,
  };
}

export function formatDirectoryList(
  entries: SkillDirEntry[],
  opts: {
    path: string;
    header?: { text: string; trimmed: boolean };
    printSummary?: boolean;
    printDescription?: boolean;
    from: number;
    to: number;
    total: number;
    remaining: number;
  },
): string {
  const title = opts.path === "" ? "." : opts.path;
  const lines = [
    `# ${title}  (printed ${opts.from} to ${opts.to} of ${opts.total}, remaining ${opts.remaining})`,
    "",
  ];
  if (opts.header?.text) {
    lines.push(formatContextPointer(opts.path, opts.header.text, opts.header.trimmed));
    lines.push("");
  }
  if (opts.total === 0) {
    lines.push("(empty)");
    return lines.join("\n");
  }
  if (entries.length === 0) {
    lines.push(
      `offset is past the end. Call skill_list with path=${title} offset=${Math.max(0, opts.total - DEFAULT_LIST_LIMIT)} for the last page.`,
    );
    return lines.join("\n");
  }
  for (const entry of entries) {
    if (entry.kind === "dir") {
      const pointer = entry.blurb
        ? `  ${formatContextPointer(entry.path, entry.blurb, entry.trimmed === true)}`
        : "";
      lines.push(`- ${entry.segment}/${pointer}`);
      continue;
    }
    const tag = entry.skill?.disableModelInvocation ? " [slash-only]" : "";
    const summary = foldLine(entry.skill?.summary);
    const description = foldLine(entry.skill?.description);
    if (opts.printSummary && !opts.printDescription) {
      const text = summary ?? description ?? "";
      lines.push(text ? `- ${entry.segment}${tag}: ${text}` : `- ${entry.segment}${tag}`);
    } else if (opts.printDescription && description) {
      lines.push(`- ${entry.segment}${tag}: ${description}`);
    } else {
      lines.push(`- ${entry.segment}${tag}`);
    }
  }
  if (opts.remaining > 0) {
    const pathArg = opts.path === "" ? "" : ` path=${opts.path}`;
    lines.push("");
    lines.push(`Call skill_list with${pathArg} offset=${opts.to + 1} to continue.`);
  }
  return lines.join("\n");
}

/**
 * Whole loaded tree for the skill_find model: every level, catalog-relative
 * paths, one summary line per skill. Slash-only skills are omitted, and a
 * directory is omitted when every skill under it is slash-only.
 * Summary is the summary frontmatter field, then the catalog description.
 */
export function formatFinderTree(tree: CatalogTree): string {
  if (tree.error) return "";
  const lines: string[] = [];
  const visible = (dir: string): boolean => {
    for (const entry of tree.entries.get(dir) ?? []) {
      if (entry.kind === "skill") {
        if (!entry.skill?.disableModelInvocation) return true;
      } else if (visible(entry.path)) return true;
    }
    return false;
  };
  const walk = (dir: string) => {
    for (const entry of tree.entries.get(dir) ?? []) {
      if (entry.kind === "dir") {
        if (!visible(entry.path)) continue;
        lines.push(`${entry.path}/`);
        walk(entry.path);
        continue;
      }
      if (!entry.skill || entry.skill.disableModelInvocation) continue;
      const summary = foldLine(
        entry.skill.summary ?? readSummary(entry.skill) ?? entry.skill.description,
      );
      lines.push(summary ? `${entry.path}: ${summary}` : entry.path);
    }
  };
  walk("");
  return lines.join("\n");
}

export function formatSkillTree(tree: CatalogTree): string {
  if (tree.error) return tree.error;
  const lines: string[] = [];
  const walk = (dir: string, indent: string) => {
    for (const entry of tree.entries.get(dir) ?? []) {
      if (entry.kind === "dir") {
        lines.push(`${indent}${entry.segment}/`);
        walk(entry.path, `${indent}  `);
      } else {
        const tag = entry.skill?.disableModelInvocation ? " [slash-only]" : "";
        lines.push(`${indent}${entry.segment}${tag}`);
      }
    }
  };
  walk("", "");
  return lines.length === 0 ? "No skills loaded." : lines.join("\n");
}

export function contextFileFor(
  roots: string[],
  rawPath: string | undefined,
): { ok: true; path: string; file: string } | { ok: false; error: string } {
  const dirPath = normalizeCatalogPath(rawPath);
  const files = contextFiles(roots, dirPath);
  if (files.length > 1) {
    return {
      ok: false,
      error: `Two context.md files for ${dirPath || "."}: ${files[0]} and ${files[1]}`,
    };
  }
  if (files.length === 0) {
    return {
      ok: false,
      error: `No context.md for ${JSON.stringify(dirPath || ".")}.`,
    };
  }
  return { ok: true, path: dirPath, file: files[0]! };
}

// ---------------------------------------------------------------------------
// skill_manage: the agent's procedural memory. Writes land only in the host
// catalog (~/.agents/skills). Project skills and other roots stay read-only.
// ---------------------------------------------------------------------------

/**
 * Root directory skill_manage writes into: the host catalog. Resolved
 * lazily so tests can point HOME at a temp dir; cache per homedir value.
 */
export function manageRoot(): string {
  return path.join(os.homedir(), ".agents", "skills");
}

export function isManageTarget(baseDir: string): boolean {
  return isLexicallyInside(manageRoot(), baseDir);
}

export const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

export function validateSkillName(name: string): string | undefined {
  if (!SKILL_NAME_PATTERN.test(name)) {
    return `Skill name ${JSON.stringify(name)} does not match ${SKILL_NAME_PATTERN.toString()}. Use lowercase letters, digits, and hyphens, starting with a letter.`;
  }
  return undefined;
}

export function validateSkillContent(
  name: string,
  content: string,
): string[] {
  const errors: string[] = [];
  const frontmatter = extractFrontmatter(content);
  if (frontmatter === undefined) {
    errors.push(
      "SKILL.md must start with a YAML frontmatter block (--- ... ---) with name and description.",
    );
    return errors;
  }
  const fmName = pickFrontmatterValue(frontmatter, "name");
  if (!fmName) {
    errors.push('Frontmatter is missing a "name:" field.');
  } else if (fmName !== name) {
    errors.push(
      `Frontmatter name ${JSON.stringify(fmName)} does not match the skill name ${JSON.stringify(name)}; they must be identical.`,
    );
  }
  const description = pickFrontmatterValue(frontmatter, "description");
  if (!description) {
    errors.push('Frontmatter is missing a "description:" field.');
  } else if (description.length > 1024) {
    errors.push(
      `Frontmatter description is ${description.length} characters; keep it under 1024.`,
    );
  }
  return errors;
}

export function manageCreate(
  name: string,
  content: string,
): { ok: true; baseDir: string; filePath: string } | ResolveErr {
  const nameError = validateSkillName(name);
  if (nameError) return { ok: false, error: nameError };
  const contentErrors = validateSkillContent(name, content);
  if (contentErrors.length > 0) {
    return { ok: false, error: contentErrors.join(" ") };
  }
  const baseDir = path.join(manageRoot(), name);
  if (fs.existsSync(baseDir)) {
    return {
      ok: false,
      error: `Skill directory ${baseDir} already exists. To replace its SKILL.md, use action "patch" with content; to add a companion file, use "write_file".`,
    };
  }
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, "SKILL.md");
  fs.writeFileSync(filePath, content.endsWith("\n") ? content : content + "\n", "utf8");
  return { ok: true, baseDir, filePath };
}

export function managePatch(
  skills: SkillRef[],
  name: string,
  oldString: string,
  newString: string,
): { ok: true; filePath: string; content: string } | ResolveErr {
  const found = findSkill(skills, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. skill_manage can only patch skills in the catalog; call skill_list to see available names.`,
    };
  }
  if (!isManageTarget(found.skill.baseDir)) {
    return {
      ok: false,
      error: `Skill ${found.skill.name} lives outside ${manageRoot()}; skill_manage writes only into the host catalog. Edit it at ${found.skill.filePath} with the user's normal tools.`,
    };
  }
  const read = readSkillFile(found.skill.filePath);
  if (!read.ok) return read;
  const occurrences = read.content.split(oldString).length - 1;
  if (occurrences === 0) {
    return {
      ok: false,
      error: `old_string not found in ${found.skill.name}/SKILL.md. Read the current content with skill_view name=${found.skill.name} first.`,
    };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: `old_string matches ${occurrences} places in ${found.skill.name}/SKILL.md; include more surrounding lines so it matches exactly one place.`,
    };
  }
  const next = read.content.replace(oldString, newString);
  const contentErrors = validateSkillContent(found.skill.name, next);
  if (contentErrors.length > 0) {
    return { ok: false, error: contentErrors.join(" ") };
  }
  fs.writeFileSync(found.skill.filePath, next, "utf8");
  return { ok: true, filePath: found.skill.filePath, content: next };
}

export function manageWriteFile(
  skills: SkillRef[],
  name: string,
  filePath: string,
  fileContent: string,
): { ok: true; absPath: string } | ResolveErr {
  const found = findSkill(skills, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. skill_manage can only write files of skills in the catalog; call skill_list to see available names.`,
    };
  }
  if (!isManageTarget(found.skill.baseDir)) {
    return {
      ok: false,
      error: `Skill ${found.skill.name} lives outside ${manageRoot()}; skill_manage writes only into the host catalog. Edit it at ${found.skill.baseDir} with the user's normal tools.`,
    };
  }
  const relPath = filePath.trim().replace(/^[/\\]+/, "");
  if (!relPath || relPath === "SKILL.md") {
    return {
      ok: false,
      error: `file_path ${JSON.stringify(filePath)} is empty or is SKILL.md; use action "patch" to change SKILL.md.`,
    };
  }
  const absPath = path.resolve(found.skill.baseDir, relPath);
  if (!isLexicallyInside(found.skill.baseDir, absPath)) {
    return {
      ok: false,
      error: `file_path ${JSON.stringify(relPath)} escapes skill directory ${found.skill.name}`,
    };
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(
    absPath,
    fileContent.endsWith("\n") ? fileContent : fileContent + "\n",
    "utf8",
  );
  return { ok: true, absPath };
}

export function manageRemoveFile(
  skills: SkillRef[],
  name: string,
  filePath: string,
): { ok: true; absPath: string; wasEmpty: boolean } | ResolveErr {
  const found = findSkill(skills, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Call skill_list to see available names.`,
    };
  }
  if (!isManageTarget(found.skill.baseDir)) {
    return {
      ok: false,
      error: `Skill ${found.skill.name} lives outside ${manageRoot()}; skill_manage writes only into the host catalog.`,
    };
  }
  const relPath = filePath.trim().replace(/^[/\\]+/, "");
  if (!relPath || relPath === "SKILL.md") {
    return {
      ok: false,
      error: `file_path ${JSON.stringify(filePath)} is empty or is SKILL.md; to delete the whole skill, use action "delete".`,
    };
  }
  const absPath = path.resolve(found.skill.baseDir, relPath);
  if (!isLexicallyInside(found.skill.baseDir, absPath)) {
    return {
      ok: false,
      error: `file_path ${JSON.stringify(relPath)} escapes skill directory ${found.skill.name}`,
    };
  }
  if (!fs.existsSync(absPath)) {
    return {
      ok: false,
      error: `file ${JSON.stringify(relPath)} not found in skill ${found.skill.name}`,
    };
  }
  fs.rmSync(absPath);
  // Prune directories left empty under the skill dir (references/ etc.).
  let dir = path.dirname(absPath);
  while (
    dir !== found.skill.baseDir &&
    dir.startsWith(found.skill.baseDir)
  ) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  const remaining = fs.readdirSync(found.skill.baseDir);
  return { ok: true, absPath, wasEmpty: remaining.length === 0 };
}

export function manageDelete(
  skills: SkillRef[],
  name: string,
): { ok: true; baseDir: string } | ResolveErr {
  const found = findSkill(skills, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Call skill_list to see available names.`,
    };
  }
  if (!isManageTarget(found.skill.baseDir)) {
    return {
      ok: false,
      error: `Skill ${found.skill.name} lives outside ${manageRoot()}; skill_manage deletes only skills in the host catalog. Remove it at ${found.skill.baseDir} with the user's normal tools.`,
    };
  }
  fs.rmSync(found.skill.baseDir, { recursive: true });
  return { ok: true, baseDir: found.skill.baseDir };
}

export function skillRefFromDisk(
  baseDir: string,
): { ok: true; ref: SkillRef } | ResolveErr {
  const filePath = path.join(baseDir, "SKILL.md");
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: `${filePath} not found` };
  }
  const read = readSkillFile(filePath);
  if (!read.ok) return read;
  const frontmatter = extractFrontmatter(read.content);
  const name =
    pickFrontmatterValue(frontmatter, "name") ?? path.basename(baseDir);
  const description = pickFrontmatterValue(frontmatter, "description") ?? "";
  return {
    ok: true,
    ref: { name, description, filePath, baseDir },
  };
}

// ---------------------------------------------------------------------------
// skill_edit / skill_file_edit: Pi-style exact-text patches on any loaded skill.
// ---------------------------------------------------------------------------

export type TextEdit = { oldText: string; newText: string };

function isTextEdit(value: unknown): value is TextEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as { oldText?: unknown; newText?: unknown };
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

/**
 * Coerce the argument shapes Pi's edit tool accepts before schema validation:
 * edits as a JSON string, a single edit object, or top-level oldText/newText.
 */
export function prepareSkillEditArguments(
  input: unknown,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const args = { ...(input as Record<string, unknown>) };
  if (typeof args.edits === "string") {
    try {
      const parsed: unknown = JSON.parse(args.edits);
      if (Array.isArray(parsed)) args.edits = parsed;
      else if (isTextEdit(parsed)) args.edits = [parsed];
    } catch {
      // Leave the string so schema validation can report it.
    }
  } else if (isTextEdit(args.edits)) {
    args.edits = [args.edits];
  }
  if (typeof args.oldText === "string" && typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    delete args.oldText;
    delete args.newText;
    args.edits = edits;
  }
  return args;
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlfIdx = content.indexOf("\r\n");
  const lfIdx = content.indexOf("\n");
  if (lfIdx === -1 || crlfIdx === -1) return "\n";
  return crlfIdx < lfIdx ? "\r\n" : "\n";
}

function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function restoreLineEndings(text: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

function splitBom(text: string): { bom: string; text: string } {
  if (text.charCodeAt(0) === 0xfeff) return { bom: "\uFEFF", text: text.slice(1) };
  return { bom: "", text };
}

function countExactOccurrences(content: string, oldText: string): number {
  if (oldText.length === 0) return 0;
  return content.split(oldText).length - 1;
}

type MatchedEdit = {
  editIndex: number;
  matchIndex: number;
  matchLength: number;
  newText: string;
};

function applyReplacements(content: string, replacements: MatchedEdit[]): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i]!;
    result =
      result.slice(0, replacement.matchIndex) +
      replacement.newText +
      result.slice(replacement.matchIndex + replacement.matchLength);
  }
  return result;
}

export type ApplyTextEditsOk = { ok: true; content: string };
export type ApplyTextEditsErr = { ok: false; error: string };

/**
 * Apply one or more exact-text replacements the way Pi's edit tool does.
 * Every oldText is matched against the original document (not incrementally).
 * Replacements are applied from the end so offsets stay valid.
 */
export function applyTextEdits(
  content: string,
  edits: TextEdit[],
  label = "file",
): ApplyTextEditsOk | ApplyTextEditsErr {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: "edits must contain at least one replacement." };
  }

  const { bom, text } = splitBom(content);
  const ending = detectLineEnding(text);
  const normalizedContent = normalizeToLF(text);
  const normalizedEdits = edits.map((edit) => ({
    oldText: normalizeToLF(edit.oldText),
    newText: normalizeToLF(edit.newText),
  }));

  for (let i = 0; i < normalizedEdits.length; i++) {
    if (normalizedEdits[i]!.oldText.length === 0) {
      return {
        ok: false,
        error:
          normalizedEdits.length === 1
            ? `oldText must not be empty in ${label}.`
            : `edits[${i}].oldText must not be empty in ${label}.`,
      };
    }
  }

  const matchedEdits: MatchedEdit[] = [];
  for (let i = 0; i < normalizedEdits.length; i++) {
    const edit = normalizedEdits[i]!;
    const matchIndex = normalizedContent.indexOf(edit.oldText);
    if (matchIndex === -1) {
      return {
        ok: false,
        error:
          normalizedEdits.length === 1
            ? `Could not find the exact text in ${label}. The old text must match exactly including all whitespace and newlines. Call skill_view or skill_file_view first.`
            : `Could not find edits[${i}] in ${label}. The oldText must match exactly including all whitespace and newlines. Call skill_view or skill_file_view first.`,
      };
    }
    const occurrences = countExactOccurrences(normalizedContent, edit.oldText);
    if (occurrences > 1) {
      return {
        ok: false,
        error:
          normalizedEdits.length === 1
            ? `Found ${occurrences} occurrences of the text in ${label}. The text must be unique. Include more surrounding lines.`
            : `Found ${occurrences} occurrences of edits[${i}] in ${label}. Each oldText must be unique. Include more surrounding lines.`,
      };
    }
    matchedEdits.push({
      editIndex: i,
      matchIndex,
      matchLength: edit.oldText.length,
      newText: edit.newText,
    });
  }

  matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
  for (let i = 1; i < matchedEdits.length; i++) {
    const previous = matchedEdits[i - 1]!;
    const current = matchedEdits[i]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) {
      return {
        ok: false,
        error: `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${label}. Merge them into one edit or target disjoint regions.`,
      };
    }
  }

  const newContent = applyReplacements(normalizedContent, matchedEdits);
  if (normalizedContent === newContent) {
    return {
      ok: false,
      error:
        normalizedEdits.length === 1
          ? `No changes made to ${label}. The replacement produced identical content.`
          : `No changes made to ${label}. The replacements produced identical content.`,
    };
  }

  return {
    ok: true,
    content: bom + restoreLineEndings(newContent, ending),
  };
}

export type EditSkillFileOk = {
  ok: true;
  skill: SkillRef;
  absPath: string;
  relPath: string;
  content: string;
};

/**
 * Patch one file under a loaded skill. Works for any catalog entry (no
 * host-only gate). SKILL.md patches revalidate frontmatter after apply.
 */
export function editSkillFile(
  skills: SkillRef[],
  name: string,
  file: string | undefined,
  edits: TextEdit[],
): EditSkillFileOk | ResolveErr {
  const resolved = resolveSkillFile(skills, name, file);
  if (!resolved.ok) return resolved;

  const read = readSkillFile(resolved.absPath);
  if (!read.ok) return read;

  const label = `${skillId(resolved.skill)}/${resolved.relPath}`;
  const applied = applyTextEdits(read.content, edits, label);
  if (!applied.ok) return applied;

  if (resolved.relPath === "SKILL.md") {
    const errors = validateSkillContent(resolved.skill.name, applied.content);
    if (errors.length > 0) {
      return { ok: false, error: errors.join(" ") };
    }
  }

  fs.writeFileSync(resolved.absPath, applied.content, "utf8");
  return {
    ok: true,
    skill: resolved.skill,
    absPath: resolved.absPath,
    relPath: resolved.relPath,
    content: applied.content,
  };
}
