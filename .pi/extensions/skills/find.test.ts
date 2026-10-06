import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import {
  CANCELLED_MESSAGE,
  FINDER_COMPLETION_CAP,
  FINDER_MODEL_ENV,
  FinderSessions,
  NO_SKILLS_MESSAGE,
  completionFromAssistant,
  finderCapMessage,
  matchModelReference,
  runSkillFind,
  type FinderCompletion,
  type FinderMessage,
} from "./find.ts";
import skillView, { toFinderProviderMessages } from "./index.ts";
import { buildCatalogTree, formatFinderTree, type SkillRef } from "./lib.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-find-"));
const root = path.join(tmp, "skills");

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeSkill(
  rel: string,
  opts: { description: string; summary?: string; slash?: boolean; body?: string; files?: Record<string, string> },
): SkillRef {
  const baseDir = path.join(root, rel);
  fs.mkdirSync(baseDir, { recursive: true });
  const front = ["---", `name: ${path.basename(rel)}`];
  if (opts.summary) front.push(`summary: ${opts.summary}`);
  if (opts.slash) front.push("disable-model-invocation: true");
  front.push("---", opts.body ?? "Do the thing.");
  fs.writeFileSync(path.join(baseDir, "SKILL.md"), front.join("\n"));
  for (const [file, body] of Object.entries(opts.files ?? {})) {
    const abs = path.join(baseDir, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return {
    name: path.basename(rel),
    description: opts.description,
    filePath: path.join(baseDir, "SKILL.md"),
    baseDir,
    disableModelInvocation: opts.slash === true,
  };
}

function catalog(skills: SkillRef[]) {
  const tree = buildCatalogTree(skills, [root]);
  return { tree, catalog: tree.skills, roots: [root] };
}

function textFinish(message: string, skill?: string): FinderCompletion {
  return {
    ok: true,
    text: "",
    toolCalls: [
      {
        id: "finish-1",
        name: "finish",
        arguments: skill ? { message, skill } : { message },
      },
    ],
  };
}

test("formatFinderTree prints summaries and skips slash-only skills", () => {
  const { tree } = catalog([
    writeSkill("deploy/ship", {
      description: "Ship a service through the pipeline",
      summary: "Ship a service",
    }),
    writeSkill("notes", { description: "Take notes when there is no summary" }),
    writeSkill("hidden/slash", { description: "Human only", slash: true }),
  ]);
  const text = formatFinderTree(tree);
  assert.match(text, /^deploy\/$/m);
  assert.match(text, /^deploy\/ship: Ship a service$/m);
  assert.match(text, /^notes: Take notes when there is no summary$/m);
  assert.equal(text.includes("slash"), false);
  assert.equal(text.includes("hidden/"), false);
});

test("a question with no tool call returns skill none and keeps the transcript", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  let seen = "";
  const result = await runSkillFind({
    task: "remember this",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async (input) => {
      seen = input.systemPrompt;
      return { ok: true, text: "Which notes?", toolCalls: [] };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, null);
  assert.equal(result.message, "Which notes?");
  assert.match(seen, /notes: Take notes/);
  const transcript = sessions.get(result.contextId!);
  assert.deepEqual(
    transcript.map((message) => message.role),
    ["user", "assistant"],
  );
});

test("finish with a tree path returns that skill", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("deploy/ship", { description: "Ship", summary: "Ship a service" }),
  ]);
  const result = await runSkillFind({
    task: "ship the api",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => textFinish("This matches the ship skill.", "deploy/ship"),
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, "deploy/ship");
  assert.equal(result.message, "This matches the ship skill.");
});

test("an unknown path is a tool error and the finder can choose again", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("deploy/ship", { description: "Ship", summary: "Ship a service" }),
  ]);
  let calls = 0;
  const result = await runSkillFind({
    task: "ship the api",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      calls += 1;
      if (calls === 1) return textFinish("maybe", "missing");
      return textFinish("use ship", "deploy/ship");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, "deploy/ship");
  const errors = sessions
    .get(result.contextId!)
    .filter((message) => message.role === "toolResult" && message.isError);
  assert.equal(errors.length, 1);
});

test("the cap runs the last tool calls and does not start another completion", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes", body: "line\n".repeat(250) }),
  ]);
  let calls = 0;
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      calls += 1;
      return {
        ok: true,
        text: "",
        toolCalls: [{ id: `view-${calls}`, name: "skill_view", arguments: { name: "notes" } }],
      };
    },
  });
  assert.equal(calls, FINDER_COMPLETION_CAP);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, null);
  assert.equal(result.message, finderCapMessage());
  const transcript = sessions.get(result.contextId!);
  const views = transcript.filter((message) => message.role === "toolResult");
  assert.equal(views.length, FINDER_COMPLETION_CAP);
  const last = views.at(-1);
  assert.equal(last?.role, "toolResult");
  if (last?.role !== "toolResult") return;
  assert.match(last.text, /line/);
  assert.equal(last.text.split("line").length > 200, true);
  assert.equal(
    transcript.some((message) => message.role === "assistant" && message.text.includes("Stopped at the cap")),
    false,
  );
});

test("a valid finish on the last completion is the choice", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  let calls = 0;
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    cap: 1,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      calls += 1;
      return textFinish("notes", "notes");
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, "notes");
});

test("a provider failure keeps the task and a replayable transcript", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      throw new Error("connection reset");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /connection reset/);
  assert.ok(result.contextId);
  assert.deepEqual(
    sessions.get(result.contextId).map((message) => message.role),
    ["user"],
  );
});

test("a cancelled call before the model starts does not mint an id", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const signal = AbortSignal.abort();
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    signal,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      throw new Error("complete should not run");
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, CANCELLED_MESSAGE);
  assert.equal(result.contextId, undefined);
});

test("cancellation during tool calls drops that assistant turn", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const controller = new AbortController();
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    signal: controller.signal,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      controller.abort();
      return {
        ok: true,
        text: "",
        toolCalls: [{ id: "view-1", name: "skill_view", arguments: { name: "notes" } }],
      };
    },
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error, CANCELLED_MESSAGE);
  const transcript = sessions.get(result.contextId!);
  assert.deepEqual(
    transcript.map((message) => message.role),
    ["user"],
  );
});

test("a follow-up replays the transcript and sees the current tree", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const first = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => ({ ok: true, text: "Which kind?", toolCalls: [] }),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  let replay: FinderMessage[] = [];
  const second = await runSkillFind({
    task: "meeting notes",
    contextId: first.contextId,
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async (input) => {
      replay = input.messages.map((message) =>
        message.role === "user"
          ? { role: "user", text: message.text }
          : { role: message.role, text: "", toolCalls: [] },
      );
      assert.match(input.systemPrompt, /notes: Take notes/);
      return textFinish("meeting notes", "notes");
    },
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.skill, "notes");
  assert.deepEqual(
    replay.map((message) => (message.role === "user" ? message.text : message.role)),
    ["take notes", "assistant", "meeting notes"],
  );
});

test("reads return the whole file and refuse escapes and slash-only skills", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", {
      description: "Take notes",
      summary: "Take notes",
      files: { "notes.md": "companion text" },
    }),
    writeSkill("hidden", { description: "Hidden", slash: true }),
  ]);
  fs.writeFileSync(path.join(root, "context.md"), "Pick notes for writing.");
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [
    { name: "skill_file_view", arguments: { name: "notes", file: "../context.md" } },
    { name: "skill_file_view", arguments: { name: "notes", file: "notes.md" } },
    { name: "skill_view", arguments: { name: "hidden" } },
    { name: "skill_view_directory_context", arguments: { name: "." } },
    { name: "finish", arguments: { message: "done", skill: "notes" } },
  ];
  const result = await runSkillFind({
    task: "read",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      const next = calls.shift();
      if (!next) return textFinish("done", "notes");
      return { ok: true, text: "", toolCalls: [{ id: next.name, name: next.name, arguments: next.arguments }] };
    },
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const results = sessions
    .get(result.contextId!)
    .filter((message) => message.role === "toolResult");
  assert.equal(results[0]?.role, "toolResult");
  if (results[0]?.role !== "toolResult") return;
  assert.equal(results[0].isError, true);
  assert.match(results[1] && results[1].role === "toolResult" ? results[1].text : "", /companion text/);
  assert.equal(results[2] && results[2].role === "toolResult" ? results[2].isError : false, true);
  assert.match(results[3] && results[3].role === "toolResult" ? results[3].text : "", /Pick notes for writing/);
});

test("blank task, unknown id, busy id, and an empty tree do not call the model", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const fail = async () => {
    throw new Error("complete should not run");
  };
  const blank = await runSkillFind({
    task: "  ",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: fail,
  });
  assert.equal(blank.ok, false);
  if (!blank.ok) assert.match(blank.error, /task is empty/);

  const unknown = await runSkillFind({
    task: "take notes",
    contextId: "missing",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: fail,
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.match(unknown.error, /Unknown contextId/);

  const id = sessions.create();
  sessions.acquire(id);
  const busy = await runSkillFind({
    task: "take notes",
    contextId: id,
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: fail,
  });
  sessions.release(id);
  assert.equal(busy.ok, false);
  if (!busy.ok) {
    assert.equal(busy.contextId, id);
    assert.match(busy.error, /busy/);
  }

  const empty = await runSkillFind({
    task: "take notes",
    sessions,
    tree: buildCatalogTree([], [root]),
    catalog: [],
    roots: [root],
    resolveModel: () => ({ ok: true }),
    complete: fail,
  });
  assert.equal(empty.ok, true);
  if (empty.ok) {
    assert.equal(empty.message, NO_SKILLS_MESSAGE);
    assert.equal(empty.contextId, undefined);
  }
});

test("a follow-up model failure keeps the id and does not append", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  const first = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => ({ ok: true, text: "Which kind?", toolCalls: [] }),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const before = sessions.get(first.contextId!).length;
  const second = await runSkillFind({
    task: "meeting notes",
    contextId: first.contextId,
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: false, error: "PI_SKILL_FIND_MODEL is unset." }),
    complete: async () => {
      throw new Error("complete should not run");
    },
  });
  assert.equal(second.ok, false);
  if (second.ok) return;
  assert.equal(second.contextId, first.contextId);
  assert.equal(sessions.get(first.contextId!).length, before);
});

test("an empty finish message stays in the transcript and the loop continues", async () => {
  const sessions = new FinderSessions();
  const loaded = catalog([
    writeSkill("notes", { description: "Take notes", summary: "Take notes" }),
  ]);
  let calls = 0;
  const result = await runSkillFind({
    task: "take notes",
    sessions,
    ...loaded,
    resolveModel: () => ({ ok: true }),
    complete: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          ok: true,
          text: "",
          toolCalls: [{ id: "bad-finish", name: "finish", arguments: { message: "  " } }],
        };
      }
      return textFinish("notes", "notes");
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.skill, "notes");
});

test("a provider error result is not stored as an assistant turn", () => {
  const completion = completionFromAssistant({
    stopReason: "error",
    errorMessage: "overloaded",
    content: [{ type: "toolCall", id: "1", name: "skill_view", arguments: { name: "notes" } }],
  });
  assert.equal(completion.ok, false);
  if (completion.ok) return;
  assert.equal(completion.error, "overloaded");
});

test("replay keeps the provider assistant message and pairs tool results", () => {
  const raw = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "look", thinkingSignature: "sig" }],
  };
  const messages = toFinderProviderMessages([
    {
      role: "assistant",
      text: "",
      toolCalls: [{ id: "1", name: "skill_view", arguments: { name: "notes" } }],
      raw,
    },
    {
      role: "toolResult",
      toolCallId: "1",
      toolName: "skill_view",
      text: "body",
      isError: false,
    },
  ]);
  assert.equal(messages[0], raw);
  const tool = messages[1] as { role: string; toolCallId: string; isError: boolean };
  assert.equal(tool.role, "toolResult");
  assert.equal(tool.toolCallId, "1");
  assert.equal(tool.isError, false);
});

test("matchModelReference accepts provider/id when the id contains a slash", () => {
  const models = [
    { provider: "unikey", id: "z-ai/glm-5.2" },
    { provider: "openai", id: "gpt" },
    { provider: "other", id: "gpt" },
  ];
  assert.equal(matchModelReference("unikey/z-ai/glm-5.2", models)?.provider, "unikey");
  assert.equal(matchModelReference("missing/gpt", models), undefined);
  assert.equal(matchModelReference("gpt", models), undefined);
  assert.equal(matchModelReference("openai/gpt", models)?.provider, "openai");
});

test("skill_find is registered and reports an unset model", async () => {
  const tools = new Map<string, { execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }>();
  let start: ((event: {
    systemPrompt: string;
    systemPromptOptions: { skills: SkillRef[]; selectedTools: string[] };
  }) => void) | undefined;
  skillView({
    on(event: string, handler: (event: never) => void) {
      if (event === "before_agent_start") start = handler as typeof start;
      return () => {};
    },
    registerTool(tool: { name: string; execute: (...args: never[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> }) {
      tools.set(tool.name, tool);
    },
  } as never);
  const skill = writeSkill("wired", { description: "Wired skill", summary: "Wired" });
  start?.({
    systemPrompt: "",
    systemPromptOptions: { skills: [skill], selectedTools: ["skill_find"] },
  });
  const previous = process.env[FINDER_MODEL_ENV];
  delete process.env[FINDER_MODEL_ENV];
  try {
    const tool = tools.get("skill_find");
    assert.ok(tool);
    const result = await tool.execute(
      "call",
      { task: "use the wired skill" },
      undefined,
      undefined,
      { modelRegistry: { getAll: () => [], hasConfiguredAuth: () => false } },
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /PI_SKILL_FIND_MODEL is unset/);
    assert.equal(result.content[0].text.includes("contextId:"), false);
  } finally {
    if (previous === undefined) delete process.env[FINDER_MODEL_ENV];
    else process.env[FINDER_MODEL_ENV] = previous;
  }
});
