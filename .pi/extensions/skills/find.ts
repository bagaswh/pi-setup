/**
 * skill_find: a separate model picks one loaded skill.
 *
 * The parent sees contextId, skill, and message. The finder transcript
 * (tasks, assistant messages, tool calls, tool results) stays in memory
 * on this process, keyed by contextId.
 */

import crypto from "node:crypto";

import { Type } from "typebox";

import {
  findSkill,
  formatFinderTree,
  normalizeSkillName,
  readSkillFile,
  resolveSkillFile,
  skillId,
  contextFileFor,
  type CatalogTree,
  type SkillRef,
} from "./lib.ts";

export const FINDER_MODEL_ENV = "PI_SKILL_FIND_MODEL";
export const FINDER_COMPLETION_CAP = 8;
export const NO_SKILLS_MESSAGE = "No skills loaded.";
export const CANCELLED_MESSAGE = "The skill_find call was cancelled.";

export function finderCapMessage(cap = FINDER_COMPLETION_CAP): string {
  return `Stopped at the cap of ${cap} finder completions. Call skill_find again with this contextId to continue.`;
}

export type FinderToolCall = {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type FinderMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: FinderToolCall[]; raw?: unknown }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      text: string;
      isError: boolean;
    };

export type FinderCompletion =
  | { ok: true; text: string; toolCalls: FinderToolCall[]; raw?: unknown }
  | { ok: false; error: string };

type AssistantLike = {
  stopReason: string;
  errorMessage?: string;
  content: ReadonlyArray<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    arguments?: unknown;
  }>;
};

export function completionFromAssistant(message: AssistantLike): FinderCompletion {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    return {
      ok: false,
      error: message.errorMessage?.trim() || message.stopReason,
    };
  }
  const toolCalls: FinderToolCall[] = [];
  const texts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text" && block.text) texts.push(block.text);
    if (block.type === "toolCall" && block.id && block.name) {
      toolCalls.push({
        id: block.id,
        name: block.name,
        arguments: plainArgs(block.arguments),
      });
    }
  }
  if (message.stopReason === "length" && toolCalls.length > 0) {
    return { ok: false, error: "The finder response was cut off." };
  }
  return {
    ok: true,
    text: texts.join("\n").trim(),
    toolCalls,
    raw: message,
  };
}

export function matchModelReference<T extends { provider: string; id: string }>(
  modelReference: string,
  availableModels: readonly T[],
): T | undefined {
  const trimmedReference = modelReference.trim();
  if (!trimmedReference) return undefined;
  const normalizedReference = trimmedReference.toLowerCase();
  const canonicalMatches = availableModels.filter(
    (model) => `${model.provider}/${model.id}`.toLowerCase() === normalizedReference,
  );
  if (canonicalMatches.length === 1) return canonicalMatches[0];
  if (canonicalMatches.length > 1) return undefined;
  const slashIndex = trimmedReference.indexOf("/");
  if (slashIndex !== -1) {
    const provider = trimmedReference.slice(0, slashIndex).trim();
    const modelId = trimmedReference.slice(slashIndex + 1).trim();
    if (provider && modelId) {
      const providerMatches = availableModels.filter(
        (model) =>
          model.provider.toLowerCase() === provider.toLowerCase() &&
          model.id.toLowerCase() === modelId.toLowerCase(),
      );
      if (providerMatches.length === 1) return providerMatches[0];
      if (providerMatches.length > 1) return undefined;
    }
  }
  const idMatches = availableModels.filter(
    (model) => model.id.toLowerCase() === normalizedReference,
  );
  return idMatches.length === 1 ? idMatches[0] : undefined;
}

export const finderTools = [
  {
    name: "skill_view",
    description:
      "Read the whole SKILL.md for one loaded skill. Pass name as the catalog-relative path from the tree.",
    parameters: Type.Object({
      name: Type.String({ description: "Catalog-relative skill path." }),
    }),
  },
  {
    name: "skill_file_view",
    description:
      "Read one companion file under a loaded skill, the whole file. Pass name and file.",
    parameters: Type.Object({
      name: Type.String({ description: "Catalog-relative skill path." }),
      file: Type.String({
        description: "Path relative to the skill directory, such as references.md.",
      }),
    }),
  },
  {
    name: "skill_view_directory_context",
    description:
      "Read context.md for one directory in the skill tree, the whole file. Pass name as the catalog-relative directory path. Use . for the top.",
    parameters: Type.Object({
      name: Type.String({ description: "Catalog-relative directory path, or . for the top." }),
    }),
  },
  {
    name: "skill_read_description",
    description:
      "Read the full description of one loaded skill. Pass name. Use this when the tree line showed only the summary.",
    parameters: Type.Object({
      name: Type.String({ description: "Catalog-relative skill path." }),
    }),
  },
  {
    name: "finish",
    description:
      "End this turn. message is required. Set skill to a catalog-relative path from the tree when choosing a skill. Omit skill when you are not choosing one.",
    parameters: Type.Object({
      message: Type.String({ description: "What to tell the calling agent." }),
      skill: Type.Optional(
        Type.String({ description: "Catalog-relative path of the chosen skill." }),
      ),
    }),
  },
];

export function finderSystemPrompt(treeText: string): string {
  return [
    "You find one loaded skill for a task.",
    "",
    "The catalog tree is below. A line that ends with / is a directory. A skill line is the catalog-relative path, a colon, and the skill summary. When the skill has no summary field, the line shows its description.",
    "",
    "When the line is enough, call finish with message and skill set to that path. When you need the instructions, call skill_view with name set to the path. Call skill_file_view with name and file for a companion file. Call skill_view_directory_context with name for a directory context.md (. is the top). Call skill_read_description with name for the full description.",
    "",
    "A skill path must be a path from the tree. finish.message is required. Omit skill when you are not choosing a skill. To ask the caller a question, reply with text and call no tool.",
    "",
    treeText,
  ].join("\n");
}

export class FinderSessions {
  private transcripts = new Map<string, FinderMessage[]>();
  private inflight = new Set<string>();

  create(): string {
    const id = crypto.randomUUID();
    this.transcripts.set(id, []);
    return id;
  }

  acquire(id: string): "ok" | "missing" | "busy" {
    if (!this.transcripts.has(id)) return "missing";
    if (this.inflight.has(id)) return "busy";
    this.inflight.add(id);
    return "ok";
  }

  release(id: string): void {
    this.inflight.delete(id);
  }

  get(id: string): FinderMessage[] {
    return this.transcripts.get(id) ?? [];
  }

  save(id: string, messages: FinderMessage[]): void {
    this.transcripts.set(id, messages);
  }
}

export type SkillFindResult =
  | { ok: true; contextId?: string; skill: string | null; message: string }
  | { ok: false; contextId?: string; error: string };

export function formatSkillFindResult(result: {
  contextId?: string;
  skill: string | null;
  message: string;
}): string {
  const lines: string[] = [];
  if (result.contextId) lines.push(`contextId: ${result.contextId}`);
  lines.push(`skill: ${result.skill ?? "none"}`);
  lines.push(`message: ${result.message}`);
  return lines.join("\n");
}

type Complete = (input: {
  systemPrompt: string;
  messages: FinderMessage[];
}) => Promise<FinderCompletion>;

export async function runSkillFind(input: {
  task: string;
  contextId?: string;
  sessions: FinderSessions;
  tree: CatalogTree;
  catalog: SkillRef[];
  roots: string[];
  resolveModel: () => { ok: true } | { ok: false; error: string };
  complete: Complete;
  signal?: AbortSignal;
  cap?: number;
}): Promise<SkillFindResult> {
  const task = input.task.trim();
  if (!task) return { ok: false, error: "task is empty." };

  const requestedId = input.contextId?.trim() || undefined;
  let acquired: string | undefined;
  try {
    if (requestedId) {
      const got = input.sessions.acquire(requestedId);
      if (got === "missing") {
        return { ok: false, error: `Unknown contextId ${JSON.stringify(requestedId)}.` };
      }
      if (got === "busy") {
        return {
          ok: false,
          contextId: requestedId,
          error: "This context is busy.",
        };
      }
      acquired = requestedId;
    }

    if (input.tree.error) {
      return { ok: false, contextId: acquired, error: input.tree.error };
    }
    const treeText = formatFinderTree(input.tree);
    if (!treeText) {
      return { ok: true, contextId: acquired, skill: null, message: NO_SKILLS_MESSAGE };
    }

    const resolved = input.resolveModel();
    if (!resolved.ok) return { ok: false, contextId: acquired, error: resolved.error };

    if (input.signal?.aborted) {
      return { ok: false, contextId: acquired, error: CANCELLED_MESSAGE };
    }

    if (!acquired) {
      acquired = input.sessions.create();
      input.sessions.acquire(acquired);
    }

    const loop = await runFinderLoop({
      messages: input.sessions.get(acquired).slice(),
      task,
      systemPrompt: finderSystemPrompt(treeText),
      catalog: input.catalog,
      roots: input.roots,
      complete: input.complete,
      signal: input.signal,
      cap: input.cap ?? FINDER_COMPLETION_CAP,
    });
    input.sessions.save(acquired, loop.messages);
    if (loop.kind === "error") {
      return { ok: false, contextId: acquired, error: loop.error };
    }
    return {
      ok: true,
      contextId: acquired,
      skill: loop.skill,
      message: loop.message,
    };
  } finally {
    if (acquired) input.sessions.release(acquired);
  }
}

async function runFinderLoop(input: {
  messages: FinderMessage[];
  task: string;
  systemPrompt: string;
  catalog: SkillRef[];
  roots: string[];
  complete: Complete;
  signal?: AbortSignal;
  cap: number;
}): Promise<
  | { kind: "done"; skill: string | null; message: string; messages: FinderMessage[] }
  | { kind: "error"; error: string; messages: FinderMessage[] }
> {
  const messages = input.messages;
  messages.push({ role: "user", text: input.task });

  for (let round = 1; round <= input.cap; round++) {
    if (input.signal?.aborted) {
      return { kind: "error", error: CANCELLED_MESSAGE, messages };
    }
    const checkpoint = messages.length;
    let completion: FinderCompletion;
    try {
      completion = await input.complete({
        systemPrompt: input.systemPrompt,
        messages,
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      return { kind: "error", error: text || "The finder call failed.", messages };
    }
    if (!completion.ok) {
      return { kind: "error", error: completion.error, messages };
    }

    if (completion.toolCalls.length === 0) {
      messages.push({
        role: "assistant",
        text: completion.text,
        toolCalls: [],
        raw: completion.raw,
      });
      return {
        kind: "done",
        skill: null,
        message: completion.text,
        messages,
      };
    }

    messages.push({
      role: "assistant",
      text: completion.text,
      toolCalls: completion.toolCalls,
      raw: completion.raw,
    });

    let choice: { skill: string | null; message: string } | undefined;
    for (const call of completion.toolCalls) {
      if (input.signal?.aborted) {
        messages.splice(checkpoint);
        return { kind: "error", error: CANCELLED_MESSAGE, messages };
      }
      const outcome = executeFinderTool(input.catalog, input.roots, call);
      messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        text: outcome.text,
        isError: outcome.isError,
      });
      if (outcome.choice && !choice) choice = outcome.choice;
    }
    if (choice) {
      return { kind: "done", skill: choice.skill, message: choice.message, messages };
    }
    if (round === input.cap) {
      return {
        kind: "done",
        skill: null,
        message: finderCapMessage(input.cap),
        messages,
      };
    }
  }

  return {
    kind: "done",
    skill: null,
    message: finderCapMessage(input.cap),
    messages,
  };
}

function executeFinderTool(
  catalog: SkillRef[],
  roots: string[],
  call: FinderToolCall,
): { text: string; isError: boolean; choice?: { skill: string | null; message: string } } {
  const args = call.arguments;
  switch (call.name) {
    case "skill_view":
      return readSkillText(catalog, stringArg(args, "name"), "SKILL.md");
    case "skill_file_view": {
      const file = stringArg(args, "file");
      if (!file) return { text: "file is required.", isError: true };
      return readSkillText(catalog, stringArg(args, "name"), file);
    }
    case "skill_read_description":
      return readDescription(catalog, stringArg(args, "name"));
    case "skill_view_directory_context":
      return readDirectoryContext(roots, stringArg(args, "name") ?? ".");
    case "finish":
      return finishTurn(catalog, args);
    default:
      return { text: `Unknown tool ${JSON.stringify(call.name)}.`, isError: true };
  }
}

function finishTurn(
  catalog: SkillRef[],
  args: Record<string, unknown>,
): { text: string; isError: boolean; choice?: { skill: string | null; message: string } } {
  const message = stringArg(args, "message");
  if (!message) return { text: "finish.message is required.", isError: true };
  const skillName = stringArg(args, "skill");
  if (!skillName) {
    const text = `finish\n\n${message}`;
    return { text, isError: false, choice: { skill: null, message } };
  }
  const found = requireInvocableSkill(catalog, skillName);
  if (!found.ok) return { text: found.error, isError: true };
  const id = skillId(found.skill);
  return {
    text: `finish\n\nskill: ${id}\n\n${message}`,
    isError: false,
    choice: { skill: id, message },
  };
}

function readDescription(
  catalog: SkillRef[],
  name: string | undefined,
): { text: string; isError: boolean } {
  const found = requireInvocableSkill(catalog, name);
  if (!found.ok) return { text: found.error, isError: true };
  const description = found.skill.description.replace(/\s+/g, " ").trim();
  return {
    text: `# skill ${skillId(found.skill)}  description\n\n${description}`,
    isError: false,
  };
}

function readDirectoryContext(
  roots: string[],
  name: string,
): { text: string; isError: boolean } {
  const resolved = contextFileFor(roots, name);
  if (!resolved.ok) return { text: resolved.error, isError: true };
  const read = readSkillFile(resolved.file);
  if (!read.ok) return { text: read.error, isError: true };
  const title = resolved.path || ".";
  return {
    text: `# directory ${title}  context.md\n\n${read.content}`,
    isError: false,
  };
}

function readSkillText(
  catalog: SkillRef[],
  name: string | undefined,
  file: string,
): { text: string; isError: boolean } {
  const found = requireInvocableSkill(catalog, name);
  if (!found.ok) return { text: found.error, isError: true };
  const resolved = resolveSkillFile(catalog, skillId(found.skill), file);
  if (!resolved.ok) return { text: resolved.error, isError: true };
  const read = readSkillFile(resolved.absPath);
  if (!read.ok) return { text: read.error, isError: true };
  return {
    text: `# skill ${skillId(found.skill)}  file ${resolved.relPath}\n\n${read.content}`,
    isError: false,
  };
}

function requireInvocableSkill(
  catalog: SkillRef[],
  name: string | undefined,
): { ok: true; skill: SkillRef } | { ok: false; error: string } {
  if (!name) return { ok: false, error: "name is required." };
  const found = findSkill(catalog, name);
  if (!found) {
    return {
      ok: false,
      error: `Unknown skill ${JSON.stringify(normalizeSkillName(name))}. Choose a path from the tree.`,
    };
  }
  if (found.skill.disableModelInvocation) {
    return {
      ok: false,
      error: `Skill ${skillId(found.skill)} is slash-only. Choose another skill.`,
    };
  }
  return { ok: true, skill: found.skill };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function plainArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return plainArgs(JSON.parse(value));
    } catch {
      return {};
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
