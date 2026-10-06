/**
 * Host-side skill tools for pi-kit: skill_list, skill_search,
 * skill_read_frontmatter, skill_read_summary, skill_read_description,
 * skill_view, skill_file_view, skill_edit, skill_file_edit, skill_find.
 *
 * Pi has no Hermes skill_view. It puts host paths in <available_skills>
 * and tells the model to read them. Gondolin wraps read/bash into the VM,
 * so those paths 404. These tools run on the host (gondolin does not wrap
 * them) and read only files inside a loaded skill directory.
 *
 * Progressive disclosure: skill_list (one directory) → skill_tree →
 * skill_view_directory_context → skill_search →
 * skill_read_frontmatter → skill_view (SKILL.md) →
 * skill_file_view (companion files).
 * Skill identity is the catalog-relative path. Line windows are 0-based inclusive.
 * skill_edit / skill_file_edit patch any loaded skill with Pi-style
 * edits[{oldText,newText}] (exact unique match against the original file).
 * Tool how-to reaches agents through the registerTool descriptions and
 * promptGuidelines below — no separate skill-tools.md file is injected.
 * This extension re-injects nothing for specialists; the tools themselves
 * are registered for subagents too.
 *
 * skill_find hands the task to a separate model (PI_SKILL_FIND_MODEL).
 * That model sees the loaded tree and can read skills. The conversation
 * is kept in memory under the contextId the tool returns.
 *
 * Catalog comes from Pi's already-loaded skills
 * (before_agent_start systemPromptOptions.skills).
 */

import fs from "node:fs";
import path from "node:path";

import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import crypto from "node:crypto";

import {
  buildCatalogTree,
  clampInt,
  clampLineWindow,
  contextFileFor,
  defaultCatalogRoots,
  editSkillFile,
  extractFrontmatter,
  findSkill,
  formatDirectoryList,
  formatSearchHits,
  formatSkillFrontmatter,
  formatSkillTree,
  listDirectory,
  loadSkillFileViews,
  loadSkillView,
  normalizeSkillName,
  paginateList,
  parseAvailableSkillsBlock,
  prepareSkillEditArguments,
  readSkillFile,
  readSummary,
  resolveSkillFile,
  rewriteSkillsPrompt,
  skillId,
  skillRefFromDisk,
  skillToolsActive,
  sliceLineWindow,
  splitLines,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_FILE_VIEW_FILES,
  type CatalogTree,
  type SkillRef,
  type TextEdit,
} from "./lib.ts";
import { searchSkills } from "./search.ts";
import {
  completionFromAssistant,
  FINDER_MODEL_ENV,
  finderTools,
  formatSkillFindResult,
  FinderSessions,
  matchModelReference,
  runSkillFind,
  type FinderMessage,
} from "./find.ts";

function isTextEdit(value: unknown): value is TextEdit {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const edit = value as { oldText?: unknown; newText?: unknown };
  return typeof edit.oldText === "string" && typeof edit.newText === "string";
}

function parseEditsParam(
  raw: unknown,
): { ok: true; edits: TextEdit[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "edits must contain at least one replacement." };
  }
  const edits: TextEdit[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (!isTextEdit(item)) {
      return {
        ok: false,
        error: `edits[${i}] must include string oldText and newText.`,
      };
    }
    edits.push({ oldText: item.oldText, newText: item.newText });
  }
  return { ok: true, edits };
}

const editReplaceSchema = Type.Object({
  oldText: Type.String({
    description:
      "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
  }),
  newText: Type.String({
    description: "Replacement text for this targeted edit.",
  }),
});

function toRef(skill: Skill): SkillRef {
  return {
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
  };
}

/**
 * Viewed-content tracking for the "already loaded" marker.
 *
 * Each returned window is hashed from its formatted text, so two calls with
 * different line windows (from/to) hash differently and both return in full;
 * only a byte-identical re-request of the same window short-circuits.
 * Context compression drops content from the conversation but not from
 * these sets, so a post-compression re-load needs forceView=true.
 */
function hashView(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/**
 * Shared body for skill_read_summary and future scalar-field readers:
 * resolve the skill, get the field value, print it as one heading + value.
 * fieldLabel is used in the output heading; missing describes the fallback
 * message when the field is absent.
 */
function readScalarField(
  catalog: SkillRef[],
  name: string,
  fieldLabel: string,
  getField: (skill: SkillRef) => string | undefined,
): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
  isError?: boolean;
} {
  const found = findSkill(catalog, name);
  if (!found) {
    const error = `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Call skill_list to see available names.`;
    return {
      content: [{ type: "text", text: error }],
      details: { action: "error", error },
      isError: true,
    };
  }
  let value: string | undefined;
  try {
    value = getField(found.skill);
  } catch {
    value = undefined;
  }
  if (!value) {
    return {
      content: [
        {
          type: "text",
          text: `# skill ${skillId(found.skill)}\n\n(no ${fieldLabel} field; call skill_read_description for the description)`,
        },
      ],
      details: { action: fieldLabel, name: skillId(found.skill), present: false },
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `# skill ${skillId(found.skill)}  ${fieldLabel}\n\n${value.replace(/\s+/g, " ").trim()}`,
      },
    ],
    details: { action: fieldLabel, name: skillId(found.skill), present: true },
  };
}

function resolveFinderModel(registry: {
  getAll(): Array<{ provider: string; id: string }>;
  hasConfiguredAuth(model: { provider: string; id: string }): boolean;
}):
  | { ok: true; model: { provider: string; id: string } }
  | { ok: false; error: string } {
  const ref = process.env[FINDER_MODEL_ENV]?.trim();
  if (!ref) return { ok: false, error: `${FINDER_MODEL_ENV} is unset.` };
  const model = matchModelReference(ref, registry.getAll());
  if (!model) return { ok: false, error: `Unknown model ${JSON.stringify(ref)}.` };
  if (!registry.hasConfiguredAuth(model)) {
    return { ok: false, error: `No auth configured for ${model.provider}/${model.id}.` };
  }
  return { ok: true, model };
}

export function toFinderProviderMessages(messages: FinderMessage[]) {
  const now = Date.now();
  return messages.map((message) => {
    if (message.role === "user") {
      return { role: "user" as const, content: message.text, timestamp: now };
    }
    if (message.role === "assistant") {
      if (message.raw) return message.raw;
      return {
        role: "assistant" as const,
        content: [
          ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
          ...message.toolCalls.map((call) => ({
            type: "toolCall" as const,
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        ],
        timestamp: now,
      };
    }
    return {
      role: "toolResult" as const,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: [{ type: "text" as const, text: message.text }],
      isError: message.isError,
      timestamp: now,
    };
  });
}

export default function (pi: ExtensionAPI) {
  let catalog: SkillRef[] = [];
  let roots = defaultCatalogRoots();
  let tree: CatalogTree = buildCatalogTree([], roots);
  const finderSessions = new FinderSessions();
  const viewedWindows = new Set<string>();
  const fullyViewedFiles = new Set<string>();

  pi.on("before_agent_start", (event) => {
    const loaded = (event.systemPromptOptions.skills ?? []).map(toRef);
    roots = defaultCatalogRoots();
    tree = buildCatalogTree(
      loaded.length > 0 ? loaded : parseAvailableSkillsBlock(event.systemPrompt),
      roots,
    );
    catalog = tree.skills;
    if (!skillToolsActive(event.systemPromptOptions.selectedTools)) {
      return;
    }
    const rewritten = rewriteSkillsPrompt(event.systemPrompt);
    if (rewritten === event.systemPrompt) return;
    return { systemPrompt: rewritten };
  });

  pi.registerTool({
    name: "skill_list",
    label: "Skill list",
    description:
      "List one directory of the loaded skill tree, like ls. Omit path for the top. A category entry is the directory name with a trailing slash and the context.md blurb (summary, else description, else the first 200 characters). A skill entry is the path segment. Paged: default 20, pass offset to continue. Set printSummary to append each skill's summary. Set printDescription to append each skill's full description. Call skill_tree for the whole tree. Call skill_view with the catalog-relative path to load a skill.",
    promptSnippet:
      "List one directory of the loaded skill tree; pass path to descend",
    promptGuidelines: [
      "Call skill_list with no path for the top of the loaded skill tree. Pass path to list that directory. A trailing slash marks a category; call skill_list with that path to descend. Call skill_view with the catalog-relative path to load a skill. Call skill_tree for every level at once. Pass offset to continue a page.",
    ],
    parameters: Type.Object({
      path: Type.Optional(
        Type.String({
          description:
            "Catalog-relative directory to list, such as security or a/b. Omit for the top.",
        }),
      ),
      printSummary: Type.Optional(
        Type.Boolean({
          description:
            "If true, append each skill's summary after the segment. Prints the summary frontmatter field, falling back to description when absent. Default false.",
        }),
      ),
      printDescription: Type.Optional(
        Type.Boolean({
          description:
            "If true, append each skill's full description after the segment. Default false.",
        }),
      ),
      offset: Type.Optional(
        Type.Number({
          description:
            "0-based index of the first entry to print. Default 0.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "How many entries to print. Default 20, maximum 40.",
        }),
      ),
    }),
    async execute(_id, params) {
      const listed = listDirectory(tree, params.path);
      if (!listed.ok) {
        return {
          content: [{ type: "text" as const, text: listed.error }],
          details: { action: "error", error: listed.error },
          isError: true,
        };
      }
      const printSummary = params.printSummary === true;
      const printDescription = params.printDescription === true;
      const page = paginateList(listed.entries, params.offset, params.limit);
      const items =
        printSummary && !printDescription
          ? page.items.map((entry) => {
              if (entry.kind !== "skill" || !entry.skill) return entry;
              return {
                ...entry,
                skill: {
                  ...entry.skill,
                  summary: entry.skill.summary ?? readSummary(entry.skill),
                },
              };
            })
          : page.items;
      return {
        content: [
          {
            type: "text" as const,
            text: formatDirectoryList(items, {
              path: listed.path,
              header: listed.header,
              printSummary,
              printDescription,
              from: page.from,
              to: page.to,
              total: page.total,
              remaining: page.remaining,
            }),
          },
        ],
        details: {
          action: "list",
          path: listed.path,
          count: page.total,
          from: page.from,
          to: page.to,
          remaining: page.remaining,
          printSummary,
          printDescription,
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_tree",
    label: "Skill tree",
    description:
      "Print the loaded skill tree, every level, names only. Categories end with a slash. Skills are the path segment. No blurbs and no paging. Call skill_list to read a directory blurb. Call skill_view with the catalog-relative path to load a skill.",
    promptSnippet: "Print the loaded skill tree, names only",
    promptGuidelines: [
      "Call skill_tree to see every loaded category and skill. Call skill_list with path to read a directory's context.md blurb. Call skill_view with the catalog-relative path to load a skill.",
    ],
    parameters: Type.Object({}),
    async execute() {
      const text = formatSkillTree(tree);
      return {
        content: [{ type: "text" as const, text }],
        details: { action: "tree", error: tree.error },
        isError: Boolean(tree.error),
      };
    },
  });

  pi.registerTool({
    name: "skill_view_directory_context",
    label: "Skill directory context",
    description:
      "Load context.md for one directory in the skill tree. Pass name as the catalog-relative directory path (. for the top). Same line window as skill_view: 0-based inclusive from and to, default 80 lines, max 200. A file of 200 lines or fewer returns in one call when from and to are omitted. If remaining > 0, call again until remaining is 0. Re-requesting a window already returned short-circuits; pass forceView=true after context compression.",
    promptSnippet:
      "Load a directory's context.md; pass name, continue until remaining is 0",
    promptGuidelines: [
      "Call skill_view_directory_context with name set to the directory path. Use . for the top. If remaining > 0, call again with from and to until remaining is 0. from and to are 0-based inclusive.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          "Catalog-relative directory path, such as security or a/b. Use . for the top.",
      }),
      from: Type.Optional(
        Type.Number({
          description: "First line to print, 0-based inclusive. Default 0.",
        }),
      ),
      to: Type.Optional(
        Type.Number({
          description:
            "Last line to print, 0-based inclusive. Default from+79 (80 lines). Maximum window 200 lines.",
        }),
      ),
      forceView: Type.Optional(
        Type.Boolean({
          description:
            "If true, return the window even when that exact window was already returned in this conversation. Default false.",
        }),
      ),
    }),
    async execute(_id, params) {
      if (tree.error) {
        return {
          content: [{ type: "text" as const, text: tree.error }],
          details: { action: "error", error: tree.error },
          isError: true,
        };
      }
      const found = contextFileFor(defaultCatalogRoots(), params.name);
      if (!found.ok) {
        return {
          content: [{ type: "text" as const, text: found.error }],
          details: { action: "error", error: found.error },
          isError: true,
        };
      }
      const read = readSkillFile(found.file);
      if (!read.ok) {
        return {
          content: [{ type: "text" as const, text: read.error }],
          details: { action: "error", error: read.error },
          isError: true,
        };
      }
      const total = splitLines(read.content).length;
      const window = clampLineWindow({
        total,
        from: params.from,
        to: params.to,
      });
      const body = sliceLineWindow(read.content, window.from, window.to);
      const title = found.path === "" ? "." : found.path;
      const nextFrom = window.to + 1;
      const nextTo = Math.min(nextFrom + 79, window.total - 1);
      const lines = [
        `# directory ${title}  context.md  (printed from line ${window.from} to line ${window.to}, remaining ${window.remaining} lines)`,
      ];
      if (window.remaining > 0) {
        lines.push(
          `# Call skill_view_directory_context with name=${title} from=${nextFrom} to=${nextTo} to load the next window.`,
        );
      }
      lines.push("");
      lines.push(body);
      const text = lines.join("\n");
      const hash = hashView(text);
      if (params.forceView !== true && viewedWindows.has(hash)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `# directory ${title}  context.md  (already loaded: lines ${window.from} to ${window.to} of ${window.total} are already in this conversation as-is. A different from/to window is different content and returns normally. If context compression dropped it, call skill_view_directory_context again with forceView=true.)`,
            },
          ],
          details: {
            action: "directory_context",
            alreadyLoaded: true,
            name: title,
            from: window.from,
            to: window.to,
            remaining: window.remaining,
            total: window.total,
          },
        };
      }
      viewedWindows.add(hash);
      return {
        content: [{ type: "text" as const, text }],
        details: {
          action: "directory_context",
          name: title,
          from: window.from,
          to: window.to,
          remaining: window.remaining,
          total: window.total,
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_search",
    label: "Skill search",
    description:
      "Fuzzy full-text search across every loaded skill: SKILL.md and all text files under each skill directory. Pass searchTerm. Results are paged (default 10). Call skill_view on a hit to load that file.",
    promptSnippet:
      "Fuzzy-search skill names, descriptions, and files; pass searchTerm",
    promptGuidelines: [
      "Call skill_search with searchTerm to find a skill or a passage inside skill files. Then call skill_view for SKILL.md, or skill_file_view for companion files.",
    ],
    parameters: Type.Object({
      searchTerm: Type.String({
        description:
          'Query to match against skill names, file names, descriptions, and file bodies. Supports fuzzy and prefix matching (for example "handoff" or "composr lock").',
      }),
      offset: Type.Optional(
        Type.Number({
          description:
            "0-based index of the first hit to print. Default 0.",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description:
            "How many hits to print. Default 10, maximum 25.",
        }),
      ),
    }),
    async execute(_id, params) {
      const searchTerm = params.searchTerm.trim();
      if (!searchTerm) {
        return {
          content: [
            {
              type: "text" as const,
              text: "searchTerm is empty. Pass a query.",
            },
          ],
          details: { action: "error", error: "empty searchTerm" },
          isError: true,
        };
      }
      const hits = searchSkills(catalog, searchTerm).map((h) => ({
        ...h,
        alreadyLoaded:
          h.file === "SKILL.md"
            ? fullyViewedFiles.has(`${h.skill}:${h.file}`)
            : undefined,
      }));
      const page = paginateList(
        hits,
        params.offset,
        clampInt(
          params.limit,
          DEFAULT_SEARCH_LIMIT,
          1,
          MAX_SEARCH_LIMIT,
        ),
      );
      return {
        content: [
          {
            type: "text" as const,
            text: formatSearchHits(page.items, {
              searchTerm,
              from: page.from,
              to: page.to,
              total: page.total,
              remaining: page.remaining,
              offset: page.offset,
            }),
          },
        ],
        details: {
          action: "search",
          count: page.total,
          from: page.from,
          to: page.to,
          remaining: page.remaining,
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_read_frontmatter",
    label: "Skill frontmatter",
    description:
      "Print the YAML frontmatter of one loaded skill's SKILL.md. Pass name. Use this after skill_list when you need summary, argument-hint, or disable-model-invocation without loading the skill body. Call skill_view to load instructions.",
    promptSnippet:
      "Print one skill's YAML frontmatter from the host catalog",
    promptGuidelines: [
      "Call skill_read_frontmatter with name to read one skill's YAML frontmatter. Call skill_view to load the skill body. Call skill_file_view for companion files.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
    }),
    async execute(_id, params) {
      const resolved = resolveSkillFile(catalog, params.name, "SKILL.md");
      if (!resolved.ok) {
        return {
          content: [{ type: "text" as const, text: resolved.error }],
          details: { action: "error", error: resolved.error },
          isError: true,
        };
      }

      const read = readSkillFile(resolved.absPath);
      if (!read.ok) {
        return {
          content: [{ type: "text" as const, text: read.error }],
          details: { action: "error", error: read.error },
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: formatSkillFrontmatter({
              skill: resolved.skill,
              frontmatter: extractFrontmatter(read.content),
            }),
          },
        ],
        details: {
          action: "frontmatter",
          name: skillId(resolved.skill),
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_read_summary",
    label: "Skill summary",
    description:
      "Print one loaded skill's summary: the summary frontmatter field of its SKILL.md, falling back to the description when the field is absent. Pass name. Cheaper than skill_read_frontmatter when only the one-line summary is needed. Call skill_view to load instructions.",
    promptSnippet:
      "Print one skill's summary (summary frontmatter field, fallback description)",
    promptGuidelines: [
      "Call skill_read_summary with name to read one skill's summary. Call skill_read_frontmatter for the full YAML frontmatter. Call skill_view to load the skill body.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
    }),
    async execute(_id, params) {
      return readScalarField(catalog, params.name, "summary", (skill) =>
        skill.summary ?? readSummary(skill),
      );
    },
  });

  pi.registerTool({
    name: "skill_read_description",
    label: "Skill description",
    description:
      "Print one loaded skill's full description from the catalog. Pass name. This is the description shown in the system prompt and search hits; use it to decide whether to load the skill before paying for skill_view.",
    promptSnippet:
      "Print one skill's full description from the host catalog",
    promptGuidelines: [
      "Call skill_read_description with name to read one skill's full description. Call skill_read_summary for the shorter summary. Call skill_view to load the skill body.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
    }),
    async execute(_id, params) {
      const found = findSkill(catalog, params.name);
      if (!found) {
        const error = `Unknown skill ${JSON.stringify(normalizeSkillName(params.name))}. Call skill_list to see available names.`;
        return {
          content: [{ type: "text" as const, text: error }],
          details: { action: "error", error },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `# skill ${skillId(found.skill)}\n\n${found.skill.description.replace(/\s+/g, " ").trim()}`,
          },
        ],
        details: { action: "description", name: skillId(found.skill) },
      };
    },
  });

  pi.registerTool({
    name: "skill_view",
    label: "Skill view",
    description:
      "Load a skill's SKILL.md from the host catalog. Pass name as the catalog-relative path (clone-repo, or a/b/c). Files at or under 200 lines return in one call. Longer files page: default 80 lines, max 200, pass from and to (0-based, inclusive). SKILL.md with load-full: true returns the whole file when from and to are omitted. If remaining > 0, call again until remaining is 0. Re-requesting a window already returned in this conversation short-circuits to an already-loaded notice; different line windows are different content and always return. If context compression dropped earlier tool output, re-load with forceView=true. For companion files (references.md, something/else.md), call skill_file_view. Call skill_list first if you do not know the path.",
    promptSnippet:
      "Load SKILL.md from the host catalog; continue until remaining is 0",
    promptGuidelines: [
      "Call skill_view with name to load SKILL.md. If remaining > 0, call again with from and to until remaining is 0.",
      "An already-loaded notice means that exact window is in this conversation. After context compression, or to re-load anyway, pass forceView=true.",
      "Call skill_file_view with name and files to load companion files under that skill directory.",
      "To change SKILL.md, call skill_edit. To change a companion file, call skill_file_edit. Do not use write or edit on skill paths.",
      "Load skill text with skill_view and skill_file_view. Run a script a skill names from ~/.pi/skills/<name>/ on the sandbox.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
      file: Type.Optional(
        Type.String({
          description:
            "Path relative to the skill directory. Defaults to SKILL.md.",
        }),
      ),
      from: Type.Optional(
        Type.Number({
          description:
            "First line to print, 0-based inclusive. Default 0.",
        }),
      ),
      to: Type.Optional(
        Type.Number({
          description:
            "Last line to print, 0-based inclusive. Default from+79 (80 lines). Maximum window 200 lines.",
        }),
      ),
      forceView: Type.Optional(
        Type.Boolean({
          description:
            "If true, return the window even when that exact window was already returned in this conversation. Use after context compression dropped the earlier tool output, or to re-load on purpose. Default false.",
        }),
      ),
    }),
    async execute(_id, params) {
      const view = loadSkillView(catalog, params.name, params.file, {
        from: params.from,
        to: params.to,
        includeSiblings: true,
      });
      if (!view.ok) {
        return {
          content: [{ type: "text" as const, text: view.error }],
          details: { action: "error", error: view.error },
          isError: true,
        };
      }
      const hash = hashView(view.text);
      const force = params.forceView === true;
      if (!force && viewedWindows.has(hash)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `# skill ${skillId(view.skill)}  file ${view.relPath}  (already loaded: lines ${view.from} to ${view.to} of ${view.total} are already in this conversation as-is. A different from/to window is different content and returns normally. If context compression dropped it, call skill_view again with forceView=true.)`,
            },
          ],
          details: {
            action: "view",
            alreadyLoaded: true,
            name: skillId(view.skill),
            file: view.relPath,
            from: view.from,
            to: view.to,
            remaining: view.remaining,
            total: view.total,
          },
        };
      }
      viewedWindows.add(hash);
      if (view.from === 0 && view.remaining === 0) {
        fullyViewedFiles.add(`${skillId(view.skill)}:${view.relPath}`);
      }
      return {
        content: [{ type: "text" as const, text: view.text }],
        details: {
          action: "view",
          name: skillId(view.skill),
          file: view.relPath,
          from: view.from,
          to: view.to,
          remaining: view.remaining,
          total: view.total,
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_file_view",
    label: "Skill file view",
    description:
      "Load companion files under one loaded skill directory. Pass name (the skill) and files (relative paths such as references.md or something/else.md). Same line-window rules as skill_view: 200 lines or fewer return in one call; longer files page (default 80, max 200). Maximum 10 files per call. Use this instead of read or bash.",
    promptSnippet:
      "Load companion files under a skill directory; pass name and files",
    promptGuidelines: [
      "Call skill_file_view with name and files to load companion files under that skill. Call skill_view to load SKILL.md.",
      "To change a companion file, call skill_file_edit. To change SKILL.md, call skill_edit.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
      files: Type.Array(
        Type.String({
          description:
            "Path relative to the skill directory, for example references.md or something/else.md.",
        }),
        {
          minItems: 1,
          maxItems: MAX_FILE_VIEW_FILES,
          description:
            "Companion files to load, relative to the skill directory.",
        },
      ),
    }),
    async execute(_id, params) {
      const result = loadSkillFileViews(catalog, params.name, params.files);
      return {
        content: [{ type: "text" as const, text: result.text }],
        details: {
          action: "file_view",
          count: result.views.length,
          files: result.views.map((v) => v.relPath),
          errors: result.errors,
        },
        isError: result.views.length === 0,
      };
    },
  });

  const clearViewed = (skillName: string) => {
    const prefix = `${skillName}:`;
    for (const key of [...fullyViewedFiles]) {
      if (key.startsWith(prefix)) fullyViewedFiles.delete(key);
    }
    viewedWindows.clear();
  };

  pi.registerTool({
    name: "skill_edit",
    label: "Skill edit",
    description:
      "Edit a loaded skill's SKILL.md with exact text replacement, like Pi's edit tool. Pass name and edits as a list of {oldText, newText}. Every edits[].oldText must match a unique, non-overlapping region of the original file. Keep each oldText as small as possible while it still occurs once. If two changes affect the same block or nearby lines, merge them into one edit. Read the current content with skill_view first. Works for any loaded skill (host catalog or repo). For companion files, call skill_file_edit.",
    promptSnippet:
      "Patch SKILL.md of a loaded skill with small exact replacements, including several disjoint edits in one call",
    promptGuidelines: [
      "Call skill_edit to change SKILL.md. Each edits[].oldText must match a unique excerpt of the original file.",
      "When changing several separate places in one SKILL.md, send one skill_edit call with multiple edits[] entries.",
      "Each edits[].oldText is matched against the original file. Merge nearby changes into one edit.",
      "Read the current content with skill_view before editing. After a patch, re-load with skill_view forceView=true if you need the new text.",
      "Call skill_file_edit to change companion files under the skill directory.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
      edits: Type.Array(editReplaceSchema, {
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      }),
    }),
    prepareArguments: prepareSkillEditArguments,
    async execute(_id, params) {
      const parsed = parseEditsParam(params.edits);
      if (!parsed.ok) {
        return {
          content: [{ type: "text" as const, text: parsed.error }],
          details: { action: "edit", ok: false, error: parsed.error },
          isError: true,
        };
      }
      const res = editSkillFile(catalog, params.name, "SKILL.md", parsed.edits);
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: res.error }],
          details: { action: "edit", ok: false, error: res.error },
          isError: true,
        };
      }
      const id = skillId(res.skill);
      const refRes = skillRefFromDisk(res.skill.baseDir);
      const found = catalog.find((s) => s.filePath === res.absPath);
      if (refRes.ok && found) {
        found.description = refRes.ref.description;
        found.summary = readSummary(found);
      }
      clearViewed(id);
      return {
        content: [
          {
            type: "text" as const,
            text: `# skill ${id} edited\n\n${res.absPath}\n\nReplaced ${parsed.edits.length} block(s) in SKILL.md. Prior skill_view windows may be stale — call skill_view with forceView=true to see the new content.`,
          },
        ],
        details: {
          action: "edit",
          ok: true,
          name: id,
          file: res.relPath,
          replacements: parsed.edits.length,
        },
      };
    },
  });

  pi.registerTool({
    name: "skill_file_edit",
    label: "Skill file edit",
    description:
      "Edit one companion file under a loaded skill directory with exact text replacement, like Pi's edit tool. Pass name, file (relative path such as references.md), and edits as a list of {oldText, newText}. Every edits[].oldText must match a unique, non-overlapping region of the original file. The file must already exist. Not for SKILL.md — use skill_edit. Read the current content with skill_file_view first.",
    promptSnippet:
      "Patch a companion file under a loaded skill with small exact replacements",
    promptGuidelines: [
      "Call skill_file_edit with name, file, and edits to change one companion file. Call skill_edit for SKILL.md.",
      "Each edits[].oldText must match a unique excerpt of the original file. Merge nearby changes into one edit.",
      "Read the current content with skill_file_view before editing.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description:
          'Skill name (for example "handoff"), or a host path of a loaded skill file.',
      }),
      file: Type.String({
        description:
          "Path relative to the skill directory, for example references.md or something/else.md. Not SKILL.md.",
      }),
      edits: Type.Array(editReplaceSchema, {
        description:
          "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
      }),
    }),
    prepareArguments: prepareSkillEditArguments,
    async execute(_id, params) {
      const rel = (params.file ?? "").trim().replace(/^[/\\]+/, "");
      if (!rel || rel === "SKILL.md") {
        const error =
          'file must be a companion path under the skill directory (for example references.md). Use skill_edit to change SKILL.md.';
        return {
          content: [{ type: "text" as const, text: error }],
          details: { action: "file_edit", ok: false, error },
          isError: true,
        };
      }
      const parsed = parseEditsParam(params.edits);
      if (!parsed.ok) {
        return {
          content: [{ type: "text" as const, text: parsed.error }],
          details: { action: "file_edit", ok: false, error: parsed.error },
          isError: true,
        };
      }
      const res = editSkillFile(catalog, params.name, rel, parsed.edits);
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: res.error }],
          details: { action: "file_edit", ok: false, error: res.error },
          isError: true,
        };
      }
      const id = skillId(res.skill);
      clearViewed(id);
      return {
        content: [
          {
            type: "text" as const,
            text: `# skill ${id} file edited\n\n${res.absPath}\n\nReplaced ${parsed.edits.length} block(s) in ${res.relPath}. Prior skill_file_view windows may be stale — call skill_file_view again to see the new content.`,
          },
        ],
        details: {
          action: "file_edit",
          ok: true,
          name: id,
          file: res.relPath,
          replacements: parsed.edits.length,
        },
      };
    },
  });

  // pi.registerTool({
  //   name: "skill_manage",
  //   label: "Skill manage",
  //   description:
  //     "Create, update, and delete skills in the host catalog (~/.agents/skills) — the agent's procedural memory. Use it when the session worked out a non-trivial workflow worth repeating, hit errors and found the working path, or the user corrected the approach: save the lesson as a skill. Capture lessons, not logs: generalizable rules with one clause of why, no incident narration, PR numbers, dates, or quoted chat. Actions: create (name + content: a full SKILL.md with frontmatter whose name matches and a description under 1024 chars), patch (name + old_string/new_string, preferred for targeted fixes to an existing SKILL.md), write_file (name + file_path + file_content for companion files like references/*.md), remove_file (name + file_path), delete (name, removes the whole skill). One text slot per action: content for create, new_string for patch, file_content for write_file. The catalog is a git repo — the user reviews changes there; never touch skills outside the catalog. New skills need an entry in the SKILLS list in bin/aide before sessions load them.",
  //   promptSnippet:
  //     "Write skills to the host catalog (create/patch/write_file/remove_file/delete)",
  //   promptGuidelines: [
  //     "When the session worked out a workflow worth repeating, an error-dead-end with a working path, or a user correction, save it with skill_manage — lessons, not logs.",
  //     "Prefer action patch over rewriting: old_string must match exactly one place in SKILL.md; read the current content with skill_view first.",
  //     "skill_manage writes only into ~/.agents/skills. Skills loaded from other directories are read-only for this tool.",
  //     "Follow the writing-for-agents skill when authoring: sharp context pointers, progressive disclosure, single source of truth.",
  //   ],
  //   parameters: Type.Union(
  //     [
  //       Type.Object({
  //         action: Type.Literal("create"),
  //         name: Type.String({
  //           description: 'New skill name, e.g. "deploy-runbook". Lowercase letters, digits, hyphens, starting with a letter.',
  //         }),
  //         content: Type.String({
  //           description: "Full SKILL.md content, starting with --- frontmatter (name matching the name param, description under 1024 chars).",
  //         }),
  //       }),
  //       Type.Object({
  //         action: Type.Literal("patch"),
  //         name: Type.String({
  //           description: "Name of an existing catalog skill.",
  //         }),
  //         old_string: Type.String({
  //           description: "Exact text to replace. Must match exactly one place in the SKILL.md.",
  //         }),
  //         new_string: Type.String({
  //           description: "Replacement text.",
  //         }),
  //       }),
  //       Type.Object({
  //         action: Type.Literal("write_file"),
  //         name: Type.String({
  //           description: "Name of an existing catalog skill.",
  //         }),
  //         file_path: Type.String({
  //           description: "Path relative to the skill directory, e.g. references/decision-table.md. Not SKILL.md — use patch for that.",
  //         }),
  //         file_content: Type.String({
  //           description: "Full content of the companion file.",
  //         }),
  //       }),
  //       Type.Object({
  //         action: Type.Literal("remove_file"),
  //         name: Type.String({ description: "Name of an existing catalog skill." }),
  //         file_path: Type.String({
  //           description: "Path relative to the skill directory. Not SKILL.md — use delete to remove the whole skill.",
  //         }),
  //       }),
  //       Type.Object({
  //         action: Type.Literal("delete"),
  //         name: Type.String({
  //           description: "Name of an existing catalog skill. Removes the entire skill directory.",
  //         }),
  //       }),
  //     ],
  //     {
  //       description:
  //         "One action per call. Each action carries only its own slots: create takes name+content, patch takes name+old_string+new_string, write_file takes name+file_path+file_content, remove_file takes name+file_path, delete takes name.",
  //     },
  //   ),
  //   async execute(_id, params) {
  //     const clearViewed = (skillName: string) => {
  //       for (const key of [...fullyViewedFiles]) {
  //         if (key.startsWith(`${skillName}:`)) fullyViewedFiles.delete(key);
  //       }
  //     };
  //     if (params.action === "create") {
  //       const res = manageCreate(params.name, params.content);
  //       if (!res.ok) {
  //         return {
  //           content: [{ type: "text" as const, text: res.error }],
  //           details: { action: "create", ok: false, error: res.error },
  //           isError: true,
  //         };
  //       }
  //       const refRes = skillRefFromDisk(res.baseDir);
  //       if (refRes.ok) {
  //         catalog.push(refRes.ref);
  //       }
  //       return {
  //         content: [
  //           {
  //             type: "text" as const,
  //             text: `# skill ${params.name} created\n\n${res.filePath}\n\nAdded to the session catalog. Add ${JSON.stringify(params.name)} to the SKILLS list in bin/aide so future sessions load it. The catalog (~/.agents/skills) is a git repo: commit the new skill for review.`,
  //           },
  //         ],
  //         details: { action: "create", ok: true, name: params.name, baseDir: res.baseDir, filePath: res.filePath },
  //       };
  //     }
  //     if (params.action === "patch") {
  //       const res = managePatch(catalog, params.name, params.old_string, params.new_string);
  //       if (!res.ok) {
  //         return {
  //           content: [{ type: "text" as const, text: res.error }],
  //           details: { action: "patch", ok: false, error: res.error },
  //           isError: true,
  //         };
  //       }
  //       // description in catalog may have changed; refresh from disk
  //       const refRes = skillRefFromDisk(path.dirname(res.filePath));
  //       const found = catalog.find((s) => s.filePath === res.filePath);
  //       if (refRes.ok && found) {
  //         found.description = refRes.ref.description;
  //       }
  //       clearViewed(params.name);
  //       return {
  //         content: [
  //           {
  //             type: "text" as const,
  //             text: `# skill ${params.name} patched\n\n${res.filePath}\n\nPatched in place. Note: skill_view may report the file as "already loaded" — that refers to the pre-patch content; use forceView=true to see the new version.`,
  //           },
  //         ],
  //         details: { action: "patch", ok: true, name: params.name, filePath: res.filePath },
  //       };
  //     }
  //     if (params.action === "write_file") {
  //       const res = manageWriteFile(catalog, params.name, params.file_path, params.file_content);
  //       if (!res.ok) {
  //         return {
  //           content: [{ type: "text" as const, text: res.error }],
  //           details: { action: "write_file", ok: false, error: res.error },
  //           isError: true,
  //         };
  //       }
  //       return {
  //         content: [
  //           {
  //             type: "text" as const,
  //             text: `# skill ${params.name} file written\n\n${res.absPath}\n\nCreated or replaced in place. Load it with skill_file_view name=${params.name} files=[${path.basename(params.file_path)}].`,
  //           },
  //         ],
  //         details: { action: "write_file", ok: true, name: params.name, absPath: res.absPath },
  //       };
  //     }
  //     if (params.action === "remove_file") {
  //       const res = manageRemoveFile(catalog, params.name, params.file_path);
  //       if (res.ok && res.wasEmpty) {
  //         return {
  //           content: [
  //             {
  //               type: "text" as const,
  //               text: `# skill ${params.name} file removed\n\n${res.absPath}\n\nWarning: the skill directory is now empty (no SKILL.md left). Delete the skill or restore SKILL.md; an empty directory will not load as a skill.`,
  //             },
  //           ],
  //           details: { action: "remove_file", ok: true, name: params.name, absPath: res.absPath, wasEmpty: true },
  //           isError: true,
  //         };
  //       }
  //       if (!res.ok) {
  //         return {
  //           content: [{ type: "text" as const, text: res.error }],
  //           details: { action: "remove_file", ok: false, error: res.error },
  //           isError: true,
  //         };
  //       }
  //       return {
  //         content: [
  //           {
  //             type: "text" as const,
  //             text: `# skill ${params.name} file removed\n\n${res.absPath}`,
  //           },
  //         ],
  //         details: { action: "remove_file", ok: true, name: params.name, absPath: res.absPath },
  //       };
  //     }
  //     // delete
  //     const res = manageDelete(catalog, params.name);
  //     if (!res.ok) {
  //       return {
  //         content: [{ type: "text" as const, text: res.error }],
  //         details: { action: "delete", ok: false, error: res.error },
  //         isError: true,
  //       };
  //     }
  //     const normalized = normalizeSkillName(params.name);
  //     catalog = catalog.filter((s) => s.name !== normalized);
  //     clearViewed(normalized);
  //     return {
  //       content: [
  //         {
  //           type: "text" as const,
  //           text: `# skill ${params.name} deleted\n\nRemoved ${res.baseDir}. If it was listed in bin/aide SKILLS, remove the entry too. Recovery: the catalog is a git repo — git checkout the directory if the deletion was wrong.`,
  //         },
  //       ],
  //       details: { action: "delete", ok: true, name: params.name, baseDir: res.baseDir },
  //     };
  //   },
  // });

  pi.registerTool({
    name: "skill_find",
    label: "Skill find",
    description:
      "Find one loaded skill for a task. Pass task. A separate model searches the loaded tree and can read a skill before it chooses. The first call omits contextId and returns one. Pass that contextId, and the next task, to continue the same finder conversation. The result is contextId, skill (a catalog-relative path or none), and message. When skill is a path, call skill_view with that path. When skill is none, read message and call skill_find again with the same contextId if you should continue.",
    promptSnippet:
      "Find a loaded skill for a task; pass contextId to continue that conversation",
    promptGuidelines: [
      "Call skill_find with task when you do not know which skill applies. When the result skill is a path, call skill_view with that path.",
      "When skill is none, read message. To continue that finder conversation, call skill_find again with the same contextId and the next task.",
    ],
    parameters: Type.Object({
      task: Type.String({
        description: "The task the finder should match to a skill, or the next message in that conversation.",
      }),
      contextId: Type.Optional(
        Type.String({
          description:
            "Id returned by an earlier skill_find call. Omit to start a new finder conversation.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let model: { provider: string; id: string } | undefined;
      const result = await runSkillFind({
        task: params.task,
        contextId: params.contextId,
        sessions: finderSessions,
        tree,
        catalog,
        roots,
        signal,
        resolveModel: () => {
          const resolved = resolveFinderModel(ctx.modelRegistry);
          if (!resolved.ok) return resolved;
          model = resolved.model;
          return { ok: true };
        },
        complete: async (input) => {
          // streamSimple honors `reasoning`. complete() goes through stream(),
          // which does not, so a finder call would inherit provider thinking.
          const message = await ctx.modelRegistry
            .streamSimple(
              model,
              {
                systemPrompt: input.systemPrompt,
                messages: toFinderProviderMessages(input.messages),
                tools: finderTools,
              },
              { reasoning: "off", signal },
            )
            .result();
          return completionFromAssistant(message);
        },
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: "text" as const,
              text: formatSkillFindResult({
                contextId: result.contextId,
                skill: null,
                message: result.error,
              }),
            },
          ],
          details: { action: "error", error: result.error, contextId: result.contextId },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: formatSkillFindResult(result),
          },
        ],
        details: {
          action: "find",
          contextId: result.contextId,
          skill: result.skill,
          message: result.message,
        },
      };
    },
  });

}
