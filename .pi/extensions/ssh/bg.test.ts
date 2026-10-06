/**
 * Unit tests for SSH-backed bg_* helpers. No live host — exec is mocked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildBgKillScript,
  buildBgLogsScript,
  buildBgStartScript,
  buildBgStatusScript,
  clampLogBytes,
  MAX_LOG_BYTES,
  parseLogsOutput,
  parseStartOutput,
  parseStatusOutput,
  resolveTaskId,
  sshBgKill,
  sshBgLogs,
  sshBgRun,
  sshBgStatus,
} from "./bg.ts";
import type { ExecResult } from "./exec.ts";
import { SshTransportError } from "./exec.ts";
import type { EnabledSshTarget } from "./lib.ts";
import type { SshExecBufferedFn } from "./bg.ts";

const target: EnabledSshTarget = {
  enabled: true,
  host: "gpu-box",
  user: "ubuntu",
  identityFile: "/keys/id_ed25519",
  remoteWorkspace: "/workspace",
  localWorkspace: "/repo/workspace",
  strictHostKeyChecking: "accept-new",
  connectTimeout: 10,
  mux: true,
};

function ok(stdout: string, exitCode = 0): ExecResult {
  return {
    exitCode,
    stdout,
    stderr: "",
    stdoutBuffer: Buffer.from(stdout),
    stderrBuffer: Buffer.alloc(0),
    ok: exitCode === 0,
  };
}

function fail(stderr: string, exitCode = 1): ExecResult {
  return {
    exitCode,
    stdout: "",
    stderr,
    stdoutBuffer: Buffer.alloc(0),
    stderrBuffer: Buffer.from(stderr),
    ok: false,
  };
}

function mockExec(
  impl: (script: string) => Promise<ExecResult> | ExecResult,
): SshExecBufferedFn & { scripts: string[] } {
  const scripts: string[] = [];
  const fn = (async (_t, opts) => {
    const script = opts.script ?? opts.argv?.at(-1) ?? "";
    scripts.push(script);
    return impl(script);
  }) as SshExecBufferedFn & { scripts: string[] };
  fn.scripts = scripts;
  return fn;
}

test("buildBgStartScript cds to remote cwd and quotes the command", () => {
  const script = buildBgStartScript({
    taskDir: "/workspace/.pi/ssh-bg/sess/bdeadbeef",
    taskId: "bdeadbeef",
    name: "Wait build",
    command: "echo it's fine && sleep 1",
    cwd: "/workspace/src",
    startedAt: "2026-09-30T00:00:00.000Z",
  });
  assert.match(script, /cd -- /);
  assert.match(script, /\/workspace\/src/);
  assert.match(script, /echo it'\\''s fine && sleep 1/);
  assert.match(script, /setsid '\/workspace\/\.pi\/ssh-bg\/sess\/bdeadbeef\/run\.sh'/);
  assert.match(script, /ssh-bg\/sess\/bdeadbeef/);
  assert.match(script, /"id":"bdeadbeef"/);
});

test("buildBgStartScript does not export host HOME/PWD/USER", () => {
  const script = buildBgStartScript({
    taskDir: "/workspace/.pi/ssh-bg/sess/babc1234",
    taskId: "babc1234",
    name: "Env check",
    command: "true",
    cwd: "/workspace",
    env: {
      HOME: "/home/hostuser",
      USER: "hostuser",
      LOGNAME: "hostuser",
      SHELL: "/bin/zsh",
      PWD: "/repo/workspace",
      OLDPWD: "/repo",
      AZURE_DEVOPS_EXT_PAT: "secret",
      PATH: "/usr/bin",
    },
  });
  assert.doesNotMatch(script, /export HOME=/);
  assert.doesNotMatch(script, /export USER=/);
  assert.doesNotMatch(script, /export LOGNAME=/);
  assert.doesNotMatch(script, /export SHELL=/);
  assert.doesNotMatch(script, /export PWD=/);
  assert.doesNotMatch(script, /export OLDPWD=/);
  assert.match(script, /export AZURE_DEVOPS_EXT_PAT=/);
  assert.match(script, /secret/);
  assert.match(script, /export PATH=/);
  assert.match(script, /\/usr\/bin/);
});

test("buildBgStartScript wraps timeoutSeconds with timeout when set", () => {
  const script = buildBgStartScript({
    taskDir: "/workspace/.pi/ssh-bg/sess/b1111111",
    taskId: "b1111111",
    name: "Timed",
    command: "sleep 999",
    cwd: "/workspace",
    timeoutSeconds: 30,
  });
  assert.match(script, /command -v timeout/);
  assert.match(script, /timeout 30s sh -c/);
});

test("resolveTaskId supports exact and unambiguous prefix", () => {
  const ids = ["bdeadbeef", "bdeadbe00", "babc1234"];
  assert.equal(resolveTaskId(ids, "babc1234"), "babc1234");
  assert.equal(resolveTaskId(ids, "babc"), "babc1234");
  assert.throws(() => resolveTaskId(ids, "bdeadbe"), /Ambiguous/);
  assert.throws(() => resolveTaskId(ids, "bnope"), /Unknown/);
  assert.throws(() => resolveTaskId(ids, "  "), /Task ID is required/);
});

test("parseStatusOutput reads status pid and exit", () => {
  const parsed = parseStatusOutput(
    [
      "STATUS=completed",
      "PID=4242",
      "EXIT=0",
      'META={"id":"b1","name":"t","command":"true","cwd":"/workspace","outputPath":"/workspace/.pi/ssh-bg/s/b1/output","startedAt":"t"}',
    ].join("\n"),
  );
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.pid, 4242);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.meta?.name, "t");
});

test("clampLogBytes caps at 50KiB", () => {
  assert.equal(clampLogBytes(undefined), MAX_LOG_BYTES);
  assert.equal(clampLogBytes(999999), MAX_LOG_BYTES);
  assert.equal(clampLogBytes(100), 100);
  assert.equal(clampLogBytes(0), 1);
});

test("buildBgLogsScript bounds the remote read", () => {
  const script = buildBgLogsScript(
    "/workspace/.pi/ssh-bg/sess/b1",
    1024,
    true,
  );
  assert.match(script, /tail -c 1024/);
  assert.match(script, /TRUNCATED=/);
});

test("buildBgKillScript signals the remote process group", () => {
  const script = buildBgKillScript("/workspace/.pi/ssh-bg/sess/b1");
  assert.match(script, /kill -TERM -"\$pid"/);
  assert.match(script, /kill -KILL -"\$pid"/);
  assert.match(script, /touch "\$dir\/killed"/);
  assert.match(script, /echo killed > "\$dir\/status"/);
});

test("buildBgStatusScript probes with kill -0", () => {
  const script = buildBgStatusScript("/workspace/.pi/ssh-bg/sess/b1");
  assert.match(script, /kill -0 "\$pid"/);
  assert.match(script, /STATUS=/);
});

test("parseStartOutput and parseLogsOutput", () => {
  assert.deepEqual(parseStartOutput("bdeadbeef\n99\n/workspace/.pi/ssh-bg/s/bdeadbeef/output\n"), {
    taskId: "bdeadbeef",
    pid: 99,
    outputPath: "/workspace/.pi/ssh-bg/s/bdeadbeef/output",
  });
  const logs = parseLogsOutput(
    ["SIZE=10", "PATH=/out", "TRUNCATED=1", "MODE=tail", "hello"].join("\n"),
  );
  assert.equal(logs.truncated, true);
  assert.equal(logs.mode, "tail");
  assert.equal(logs.body, "hello");
});

test("sshBgRun starts via mocked exec and returns remote pid", async () => {
  const exec = mockExec((script) => {
    assert.match(script, /cd -- /);
    assert.match(script, /\/workspace\/build/);
    assert.match(script, /npm test/);
    assert.doesNotMatch(script, /export HOME=/);
    assert.match(script, /setsid '\/workspace\/\.pi\/ssh-bg\/sess\/bcafe000\/run\.sh'/);
    return ok("bcafe000\n4242\n/workspace/.pi/ssh-bg/sess/bcafe000/output\n");
  });
  const got = await sshBgRun(
    target,
    {
      sessionId: "sess",
      command: "npm test",
      name: "Unit tests",
      isAgent: false,
      cwd: "/workspace/build",
      env: { HOME: "/home/host", PATH: "/bin" },
      taskId: "bcafe000",
    },
    exec,
  );
  assert.equal(got.task.id, "bcafe000");
  assert.equal(got.task.pid, 4242);
  assert.equal(got.task.status, "running");
  assert.match(got.message, /does not wake a follow-up turn/);
  assert.match(got.message, /SSH host gpu-box/);
});

test("sshBgStatus lists and resolves a task", async () => {
  const exec = mockExec((script) => {
    if (script.includes("find ")) {
      return ok("b1111111\nb2222222\n");
    }
    if (script.includes("b2222222")) {
      return ok(
        [
          "STATUS=running",
          "PID=7",
          "EXIT=",
          'META={"id":"b2222222","name":"Watch","command":"sleep 9","cwd":"/workspace","outputPath":"/workspace/.pi/ssh-bg/sess/b2222222/output","startedAt":"t"}',
        ].join("\n"),
      );
    }
    return fail("unexpected", 1);
  });
  const got = await sshBgStatus(
    target,
    { sessionId: "sess", taskId: "b222" },
    exec,
  );
  assert.equal(got.tasks.length, 1);
  assert.equal(got.tasks[0]!.id, "b2222222");
  assert.equal(got.tasks[0]!.status, "running");
  assert.equal(got.tasks[0]!.pid, 7);
});

test("sshBgLogs returns bounded body and remote path when truncated", async () => {
  const exec = mockExec((script) => {
    if (script.includes("find ")) return ok("b3333333\n");
    assert.match(script, /tail -c/);
    return ok(
      ["SIZE=99999", "PATH=/workspace/.pi/ssh-bg/sess/b3333333/output", "TRUNCATED=1", "MODE=tail", "tail-bytes"].join(
        "\n",
      ),
    );
  });
  const got = await sshBgLogs(
    target,
    { sessionId: "sess", taskId: "b3333333", maxBytes: 100 },
    exec,
  );
  assert.equal(got.truncated, true);
  assert.match(got.message, /Full output: \/workspace\/\.pi\/ssh-bg\/sess\/b3333333\/output/);
  assert.match(got.message, /tail-bytes/);
});

test("sshBgKill runs the kill argv and rejects non-running", async () => {
  const exec = mockExec((script) => {
    if (script.includes("find ")) return ok("b4444444\n");
    assert.match(script, /kill -TERM -/);
    return ok("KILLED=1\nPID=9\n");
  });
  const got = await sshBgKill(
    target,
    { sessionId: "sess", taskId: "b4444444" },
    exec,
  );
  assert.equal(got.taskId, "b4444444");
  assert.match(got.message, /Killed background task b4444444/);

  const execDone = mockExec((script) => {
    if (script.includes("find ")) return ok("b4444444\n");
    return {
      ...fail("not running", 2),
      stdout: "NOT_RUNNING=completed\n",
    };
  });
  await assert.rejects(
    () => sshBgKill(target, { sessionId: "sess", taskId: "b4444444" }, execDone),
    /not running/,
  );
});

test("sshBgRun propagates transport failures without local fallback", async () => {
  const exec = mockExec(() => {
    throw new SshTransportError("ssh: connection refused");
  });
  let reported: unknown;
  await assert.rejects(
    () =>
      sshBgRun(
        target,
        {
          sessionId: "sess",
          command: "true",
          name: "x",
          isAgent: false,
          cwd: "/workspace",
        },
        exec,
        (err) => {
          reported = err;
        },
      ),
    /connection refused/,
  );
  assert.ok(reported instanceof SshTransportError);
});
