/**
 * Unit tests for SSH-backed ls/find/grep ops. No live host — exec is mocked.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EnabledSshTarget } from "./lib.ts";
import {
  buildRemoteFdScript,
  createSshFindOps,
  createSshLsOps,
  executeSshGrep,
  type SshExecBufferedFn,
} from "./ops.ts";
import type { ExecResult } from "./exec.ts";
import { SshTransportError } from "./exec.ts";

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
  impl: (argv: string[]) => Promise<ExecResult> | ExecResult,
): SshExecBufferedFn & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = (async (_t, opts) => {
    calls.push(opts.argv);
    return impl(opts.argv);
  }) as SshExecBufferedFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
}

test("buildRemoteFdScript prefers fd and quotes the pattern", () => {
  const script = buildRemoteFdScript("*.ts", "/workspace/src", 50);
  assert.match(script, /command -v fd/);
  assert.match(script, /command -v fdfind/);
  assert.match(script, /--max-results' '50'/);
  assert.match(script, /'\*\.ts'/);
  assert.match(script, /'\/workspace\/src'/);
  assert.doesNotMatch(script, /--full-path/);
});

test("buildRemoteFdScript adds --full-path and **/ for path patterns", () => {
  const script = buildRemoteFdScript("src/**/*.ts", "/workspace", 10);
  assert.match(script, /--full-path/);
  assert.match(script, /\*\*\/src\/\*\*\/\*\.ts/);
});

test("createSshLsOps.exists maps local workspace paths to remote", async () => {
  const exec = mockExec(async (argv) => {
    const script = argv.at(-1) ?? "";
    assert.match(script, /test -e '\/workspace\/pkg'/);
    return ok("");
  });
  const ops = createSshLsOps(target, () => {}, exec);
  assert.equal(await ops.exists("/repo/workspace/pkg"), true);
  assert.equal(exec.calls.length, 1);
});

test("createSshLsOps.stat reports directories", async () => {
  const exec = mockExec(async () => ok("dir\n"));
  const ops = createSshLsOps(target, () => {}, exec);
  const st = await ops.stat("/repo/workspace");
  assert.equal(st.isDirectory(), true);
});

test("createSshLsOps.readdir lists remote basenames", async () => {
  const exec = mockExec(async (argv) => {
    const script = argv.at(-1) ?? "";
    assert.match(script, /find '\/workspace' -mindepth 1 -maxdepth 1/);
    return ok("a\nb\n");
  });
  const ops = createSshLsOps(target, () => {}, exec);
  assert.deepEqual(await ops.readdir("/repo/workspace"), ["a", "b"]);
});

test("createSshFindOps.glob runs the remote fd script and returns paths", async () => {
  const exec = mockExec(async (argv) => {
    const script = argv.at(-1) ?? "";
    assert.match(script, /exec fd /);
    assert.match(script, /'\*\.go'/);
    return ok("/workspace/a.go\n/workspace/b.go\n");
  });
  const ops = createSshFindOps(target, () => {}, exec);
  const got = await ops.glob("*.go", "/repo/workspace", {
    ignore: [],
    limit: 100,
  });
  assert.deepEqual(got, ["/workspace/a.go", "/workspace/b.go"]);
});

test("createSshFindOps.glob treats fd exit 1 as empty results", async () => {
  const exec = mockExec(async () => fail("", 1));
  const ops = createSshFindOps(target, () => {}, exec);
  assert.deepEqual(
    await ops.glob("*.nope", "/repo/workspace", { ignore: [], limit: 10 }),
    [],
  );
});

test("createSshFindOps.glob surfaces missing fd", async () => {
  const exec = mockExec(async () =>
    fail("fd is not available on the SSH host (tried fd, fdfind)\n", 127),
  );
  const ops = createSshFindOps(target, () => {}, exec);
  await assert.rejects(
    () => ops.glob("*.ts", "/repo/workspace", { ignore: [], limit: 10 }),
    /fd is not available/,
  );
});

test("executeSshGrep parses remote rg JSON and formats matches", async () => {
  const exec = mockExec(async (argv) => {
    const script = argv.at(-1) ?? "";
    if (script.includes("exec rg")) {
      const match = {
        type: "match",
        data: {
          path: { text: "/workspace/a.ts" },
          line_number: 3,
          lines: { text: "hello world\n" },
        },
      };
      return ok(`${JSON.stringify(match)}\n`);
    }
    if (script.includes("test -d")) return ok("dir\n");
    return fail("unexpected");
  });
  const result = await executeSshGrep(
    target,
    { pattern: "hello" },
    {
      searchPath: "/repo/workspace",
      onTransport: () => {},
      exec,
    },
  );
  assert.match(result.content[0]!.text, /a\.ts:3: hello world/);
  assert.equal(result.details, undefined);
});

test("executeSshGrep returns No matches found on empty rg", async () => {
  const exec = mockExec(async () => fail("", 1));
  const result = await executeSshGrep(
    target,
    { pattern: "zzz" },
    {
      searchPath: "/repo/workspace",
      onTransport: () => {},
      exec,
    },
  );
  assert.equal(result.content[0]!.text, "No matches found");
});

test("executeSshGrep reports transport failures via onTransport", async () => {
  let reported: unknown;
  const exec: SshExecBufferedFn = async () => {
    throw new SshTransportError("ssh: connection refused");
  };
  await assert.rejects(
    () =>
      executeSshGrep(
        target,
        { pattern: "x" },
        {
          searchPath: "/repo/workspace",
          onTransport: (err) => {
            reported = err;
          },
          exec,
        },
      ),
    SshTransportError,
  );
  assert.ok(reported instanceof SshTransportError);
});

test("ls/find ops report transport failures via onTransport", async () => {
  let reported = 0;
  const exec: SshExecBufferedFn = async () => {
    throw new SshTransportError("ssh dead");
  };
  const ls = createSshLsOps(target, () => {
    reported++;
  }, exec);
  await assert.rejects(() => ls.exists("/repo/workspace"), SshTransportError);
  assert.equal(reported, 1);
});
