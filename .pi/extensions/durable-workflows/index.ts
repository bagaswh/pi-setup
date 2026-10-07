/**
 * index.ts — the Pi-facing `wf` tool for durable-workflows (Task 6).
 * Registers ONE tool named "wf": a thin bridge to `dispatch` in tool.ts
 * (the extension records and folds; the agent executes nodes — no
 * execution authority here). Resolves the store root from settings,
 * `durableWorkflows.storeRoot`, project settings winning over global
 * (pi's own SettingsManager layering; untrusted project settings are
 * ignored, matching pi's project-trust behavior). Absent →
 * `<cwd>/.pi/durable-workflows/`. Action-level errors are values, never
 * thrown at the action boundary: the ActionResult ({ok, result|error})
 * comes back as the tool result verbatim.
 *
 * Schema: local typebox-like object literal (context-compress pattern —
 * a real `typebox` import via createRequire when resolvable, plain JSON
 * Schema objects otherwise). `action` is required; every per-action
 * input field is optional and loose (Type.Unknown) because dispatch
 * validates strictly per the spec table.
 */

import { createRequire } from "node:module";
import path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { dispatch } from "./tool.ts";

// ---------------------------------------------------------------------------
// Typebox-like schema (context-compress pattern; no hard npm dependency)
// ---------------------------------------------------------------------------

type SchemaOptions = { description?: string };
type TypeboxLike = {
  Object: (properties: Record<string, unknown>, options?: SchemaOptions) => Record<string, unknown>;
  String: (options?: SchemaOptions) => Record<string, unknown>;
  Integer: (options?: SchemaOptions) => Record<string, unknown>;
  Array: (items: unknown, options?: SchemaOptions) => Record<string, unknown>;
  Unknown: (options?: SchemaOptions) => Record<string, unknown>;
  Optional: (schema: Record<string, unknown>) => Record<string, unknown>;
};

function withDescription(schema: Record<string, unknown>, options?: SchemaOptions): Record<string, unknown> {
  return options?.description ? { ...schema, description: options.description } : schema;
}

const Type: TypeboxLike = (() => {
  const fallback: TypeboxLike = {
    Object: (properties, options) =>
      withDescription({ type: "object", properties, required: ["action"], additionalProperties: true }, options),
    String: (options) => withDescription({ type: "string" }, options),
    Integer: (options) => withDescription({ type: "integer" }, options),
    Array: (items, options) => withDescription({ type: "array", items }, options),
    Unknown: (options) => withDescription({}, options),
    Optional: (schema) => ({ ...schema, optional: true }),
  };
  try {
    const required = createRequire(import.meta.url);
    const imported = required("typebox") as { Type?: TypeboxLike };
    return imported.Type ?? fallback;
  } catch {
    return fallback;
  }
})();

// ---------------------------------------------------------------------------
// Settings: durableWorkflows.storeRoot, project wins over global
// ---------------------------------------------------------------------------

const SETTINGS_KEY = "durableWorkflows";
const STORE_ROOT_KEY = "storeRoot";

/** Pi's agent config dir, honoring PI_CODING_AGENT_DIR like pi itself. */
function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  return env ? path.resolve(env) : path.join(process.env.HOME ?? "", CONFIG_DIR_NAME, "agent");
}

export type StoreRootSource = "project" | "global" | "default";

export type ResolvedStoreRoot = {
  storeRoot: string | null;
  source: StoreRootSource;
};

/**
 * Read `durableWorkflows.storeRoot` through pi's SettingsManager, which
 * deep-merges global `~/.pi/agent/settings.json` and project
 * `<cwd>/.pi/settings.json` with project winning — the same layering
 * context-compress implements by hand for its JSON file. Project
 * settings are dropped when the project is untrusted, matching pi's
 * own trust semantics for `<cwd>/.pi` resources.
 */
export function resolveStoreRootSetting(cwd: string, projectTrusted: boolean): ResolvedStoreRoot {
  try {
    const manager = SettingsManager.create(cwd, agentDir(), { projectTrusted });
    const read = (settings: Record<string, unknown>): string | undefined => {
      const section = settings[SETTINGS_KEY];
      if (typeof section !== "object" || section === null) return undefined;
      const value = (section as Record<string, unknown>)[STORE_ROOT_KEY];
      return typeof value === "string" && value.length > 0 ? value : undefined;
    };
    const fromProject = read(manager.getProjectSettings() as Record<string, unknown>);
    if (fromProject !== undefined) return { storeRoot: path.resolve(cwd, fromProject), source: "project" };
    const fromGlobal = read(manager.getGlobalSettings() as Record<string, unknown>);
    if (fromGlobal !== undefined) return { storeRoot: path.resolve(cwd, fromGlobal), source: "global" };
  } catch {
    // Unreadable settings must never take the tool down; fall through to
    // the store.ts default (`<cwd>/.pi`).
  }
  return { storeRoot: null, source: "default" };
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

function foldSummaryLine(result: Record<string, unknown>): string {
  const ready = Array.isArray(result.ready) ? result.ready.length : 0;
  const blocked = Array.isArray(result.blocked) ? result.blocked.length : 0;
  const orphans = Array.isArray(result.orphans) ? result.orphans.length : 0;
  const bits = [`ready: ${ready}`, `blocked: ${blocked}`];
  if (result.awaiting === true) bits.push("awaiting");
  if (orphans > 0) bits.push(`orphans: ${orphans}`);
  if (result.truncatedTail === true) bits.push("truncated tail");
  return bits.join(", ");
}

function resultSummaryLine(action: string, result: unknown): string {
  if (typeof result !== "object" || result === null) return `${action} ok`;
  const r = result as Record<string, unknown>;
  switch (action) {
    case "create":
      return `created ${String(r.thread_id)}`;
    case "next":
    case "status":
      return foldSummaryLine(r);
    case "inspect":
      return `state at entry ${String(r.up_to)}`;
    case "fork":
      return `forked ${String(r.thread_id)} (${String(r.copied)} entries)`;
    case "step_start":
      return `started ${String(r.started)}`;
    case "commit":
      return `committed ${String(r.committed)} (${String(r.status)}/${String(r.origin)})`;
    case "interrupt":
      return `interrupted: ${String(r.question)}`;
    case "resume":
      return `resumed (${String(r.answer)}); ready: ${Array.isArray(r.ready) ? r.ready.join(", ") || "none" : "?"}`;
    default:
      return `${action} ok`;
  }
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

const ACTIONS = "create, next, step_start, commit, interrupt, resume, status, inspect, fork";

export default function durableWorkflowsExtension(pi: ExtensionAPI): void {
  // Resolve the store root lazily per call so a settings change picked up
  // by /reload (and its fresh factory run) is honored without stale state.
  let cachedProjectTrusted = true;

  pi.on("session_start", (_event, ctx) => {
    cachedProjectTrusted = ctx.isProjectTrusted();
  });

  pi.registerTool({
    name: "wf",
    label: "Durable workflow",
    description:
      "Durable workflow threads: an append-only per-thread step log plus a pure fold over it. " +
      `The extension records and folds; you execute the nodes yourself. Actions: ${ACTIONS}. ` +
      "Use it to drive multi-session workflows, resume after a crash or fresh invocation " +
      "(status discovers threads, next folds the log), park a workflow on the user with " +
      "interrupt/resume, and time-travel via inspect (read-only fold to an entry) or fork " +
      "(copy a prefix to a new thread without touching the source).",
    promptSnippet:
      "Durable workflow threads (wf): record steps in an append-only log and fold it for state; " +
      "use for multi-session workflows, crash resume, interrupts, and time travel",
    promptGuidelines: [
      "Use wf to run step-by-step workflows that must survive crashes and new sessions: call wf next after each commit to see what is ready.",
      "wf step_start and wf commit must alternate per node: start a node, execute it yourself, then commit its output before starting the next.",
      "wf commit output keys must be declared reducers in the thread's graph (set, append, merge, sum, max); commit refuses a reducer violation.",
      "wf thread_id is required for every action except create (where it is optional) and status (where omitting it lists all threads); wf resume requires a pending interrupt.",
    ],
    parameters: Type.Object(
      {
        action: Type.String({
          description:
            `One of: ${ACTIONS}. create=validate graph + write thread_meta; next=fold the log; ` +
            "step_start=record a node launch; commit=record a step_result; interrupt=park on the user; " +
            "resume=answer an interrupt; status=list threads or fold one; inspect=fold a prefix read-only; " +
            "fork=copy a prefix to a new thread.",
        }),
        thread_id: Type.Optional(
          Type.String({ description: "Thread id (filesystem-safe slug). Required for all actions except create (optional) and status (optional: listing)." }),
        ),
        title: Type.Optional(Type.String({ description: "create: human title; also the thread-id slug source when thread_id is omitted" })),
        graph: Type.Optional(Type.Unknown({ description: "create: graph object {nodes:[{id,type,needs,...}], reducers, initial}" })),
        node: Type.Optional(Type.String({ description: "step_start/commit: node id from the graph" })),
        launch: Type.Optional(Type.Unknown({ description: "step_start: {kind: \"subagent\"|\"shell\", ref: string}" })),
        output: Type.Optional(Type.Unknown({ description: "commit: step output keyed by reducer-declared state keys" })),
        status: Type.Optional(Type.String({ description: "commit: \"ok\" (default) or \"error\"" })),
        summary: Type.Optional(Type.String({ description: "commit: one-line human summary" })),
        artifacts: Type.Optional(Type.Array(Type.String(), { description: "commit: artifact paths (paths, not payloads)" })),
        origin: Type.Optional(Type.String({ description: "commit: \"run\" (default) or \"rerun\"" })),
        question: Type.Optional(Type.String({ description: "interrupt: the question to park on" })),
        options: Type.Optional(Type.Array(Type.String(), { description: "interrupt: suggested answers" })),
        answer: Type.Optional(Type.String({ description: "resume: the user's typed answer" })),
        to: Type.Optional(Type.Integer({ description: "inspect/fork: entry index (0-based); fork defaults to the whole log" })),
        new_thread_id: Type.Optional(Type.String({ description: "fork: explicit id for the forked thread (default: <source>-fork-<hex>)" })),
      },
      { description: "Input passes through to dispatch, which validates strictly per action; unknown keys are ignored here and rejected there." },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const args = (params ?? {}) as Record<string, unknown>;
      const action = typeof args.action === "string" ? args.action : "";
      const cwd = ctx.cwd;
      const { storeRoot } = resolveStoreRootSetting(cwd, cachedProjectTrusted);
      const actionResult = await dispatch(action, args, { storeRoot, cwd });
      const body = JSON.stringify(actionResult, null, actionResult.ok ? 0 : 2);
      return {
        content: [{ type: "text", text: body }],
        details: actionResult,
      };
    },
    renderCall(args, theme, _context) {
      const action = typeof (args as { action?: unknown }).action === "string" ? (args as { action: string }).action : "?";
      const threadId = (args as { thread_id?: unknown }).thread_id;
      let line = theme.fg("toolTitle", theme.bold("wf ")) + theme.fg("muted", action);
      if (threadId !== undefined) line += theme.fg("dim", ` ${String(threadId)}`);
      return new Text(line, 0, 0);
    },
    renderResult(result, _options, theme, context) {
      const details = result.details as { ok?: boolean; error?: string; result?: unknown } | undefined;
      let line: string;
      if (details && details.ok === false) {
        line = theme.fg("error", `ERR: ${details.error ?? "unknown error"}`);
      } else {
        const args = (context.args ?? {}) as { action?: unknown };
        const action = typeof args.action === "string" ? args.action : "";
        const summary = details && details.ok === true ? resultSummaryLine(action, details.result) : "done";
        line = theme.fg("success", "✓ wf") + theme.fg("muted", ` ${summary}`);
      }
      return new Text(line, 0, 0);
    },
  });
}
