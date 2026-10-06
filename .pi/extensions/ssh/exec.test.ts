import assert from "node:assert/strict";
import { test } from "node:test";

import { sshExec, sshExecBuffered, ChannelSemaphore, resetChannelSemaphores, type SshIo } from "./exec.ts";
import type { EnabledSshTarget } from "./lib.ts";

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

function mockIo(
  impl: SshIo["spawn"],
): SshIo & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    spawn(argv, opts) {
      calls.push(argv);
      return impl(argv, opts);
    },
  };
}

test("sshExecBuffered runs a framed remote argv through bash -lc", async () => {
  const io = mockIo(async (argv) => {
    assert.equal(argv[0], "ssh");
    assert.ok(argv.includes("ubuntu@gpu-box"));
    assert.ok(argv.includes("-i"));
    assert.ok(argv.includes("/keys/id_ed25519"));
    const script = argv.at(-1) ?? "";
    assert.match(script, /^bash -lc '/);
    assert.match(script, /cd -- '\\''\/workspace'\\''/);
    assert.match(script, /exec '\\''\/bin\/cat'\\'' '\\''\/workspace\/README.md'\\''/);
    return {
      exitCode: 0,
      stdout: Buffer.from("hello\n"),
      stderr: Buffer.from(""),
    };
  });
  const r = await sshExecBuffered(
    target,
    {
      argv: ["/bin/cat", "/workspace/README.md"],
      cwd: "/workspace",
    },
    io,
  );
  assert.equal(r.ok, true);
  assert.equal(r.exitCode, 0);
  assert.equal(r.stdout, "hello\n");
  assert.equal(io.calls.length, 1);
});

test("sshExecBuffered returns remote nonzero without throwing", async () => {
  const io = mockIo(async () => ({
    exitCode: 1,
    stdout: Buffer.from(""),
    stderr: Buffer.from("cat: no such file\n"),
  }));
  const r = await sshExecBuffered(
    target,
    { argv: ["/bin/cat", "/workspace/missing"] },
    io,
  );
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.match(r.stderr, /no such file/);
});

test("sshExec throws SshTransportError on ssh exit 255", async () => {
  const io = mockIo(async () => ({
    exitCode: 255,
    stdout: Buffer.from(""),
    stderr: Buffer.from("ssh: connect to host gpu-box port 22: Connection refused\n"),
  }));
  await assert.rejects(
    () => sshExecBuffered(target, { argv: ["/bin/true"], _retried: true }, io),
    /transport to ubuntu@gpu-box failed/,
  );
});

resetChannelSemaphores();
test("sshExec retries once after a transport failure", async () => {
  resetChannelSemaphores();
  let calls = 0;
  const io = mockIo(async () => {
    calls++;
    if (calls === 1) {
      return {
        exitCode: 255,
        stdout: Buffer.from(""),
        stderr: Buffer.from("kex_exchange_identification: Connection reset by peer\n"),
      };
    }
    return { exitCode: 0, stdout: Buffer.from("recovered\n"), stderr: Buffer.from("") };
  });
  const r = await sshExecBuffered(target, { argv: ["/bin/true"] }, io);
  assert.equal(r.ok, true);
  assert.equal(r.stdout, "recovered\n");
  assert.equal(calls, 2);
});

test("sshExec does not retry when _retried is set", async () => {
  resetChannelSemaphores();
  let calls = 0;
  const io = mockIo(async () => {
    calls++;
    return {
      exitCode: 255,
      stdout: Buffer.from(""),
      stderr: Buffer.from("Connection closed by remote host\n"),
    };
  });
  await assert.rejects(
    () => sshExecBuffered(target, { argv: ["/bin/true"], _retried: true }, io),
    /dropped before the session started/,
  );
  assert.equal(calls, 1);
});

test("ChannelSemaphore queues waiters past the limit", async () => {
  const sem = new ChannelSemaphore(2);
  let peak = 0;
  let active = 0;
  const task = async () => {
    const release = await sem.acquire();
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    release();
  };
  await Promise.all(Array.from({ length: 6 }, task));
  assert.equal(peak, 2);
});

test("sshExec streams stdout chunks from the mock spawn", async () => {
  const io: SshIo = {
    spawn() {
      const result = Promise.resolve({
        exitCode: 0,
        stdout: Buffer.from("ab"),
        stderr: Buffer.from(""),
      });
      const withOutput = result as Promise<{
        exitCode: number;
        stdout: Buffer;
        stderr: Buffer;
      }> & {
        output: () => AsyncIterable<{ stream: "stdout" | "stderr"; data: Buffer }>;
      };
      withOutput.output = async function* () {
        yield { stream: "stdout", data: Buffer.from("a") };
        yield { stream: "stdout", data: Buffer.from("b") };
      };
      return withOutput;
    },
  };
  const proc = sshExec(target, { argv: ["/bin/echo", "ab"] }, io);
  const chunks: string[] = [];
  for await (const chunk of proc.output()) {
    chunks.push(chunk.data.toString());
  }
  const r = await proc;
  assert.deepEqual(chunks, ["a", "b"]);
  assert.equal(r.stdout, "ab");
});

test("sshExec with controlPath bootstraps the master once then runs the command", async () => {
  const io = mockIo(async (argv) => {
    if (argv.includes("-O")) {
      return { exitCode: 255, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }
    if (argv.at(-1) === "true") {
      // bootstrap connection: starts the master
      assert.ok(argv.includes("ControlMaster=auto"));
      assert.ok(argv.some((a) => a.startsWith("ControlPath=")));
      return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") };
    }
    // command over the mux socket
    assert.ok(argv.includes("ControlMaster=auto"));
    assert.ok(argv.some((a) => a.startsWith("ControlPath=")));
    return {
      exitCode: 0,
      stdout: Buffer.from("ok\n"),
      stderr: Buffer.from(""),
    };
  });
  const r = await sshExecBuffered(
    {
      ...target,
      controlPath: "/tmp/pi-kit-ssh/cm-test-1",
    },
    { argv: ["/bin/true"] },
    io,
  );
  assert.equal(r.ok, true);
  // check, bootstrap (master start), command
  assert.equal(io.calls.length, 3);
  assert.ok(io.calls[0]!.includes("check"));
  assert.equal(io.calls[1]!.at(-1), "true");
  assert.ok(io.calls[2]!.includes("ControlMaster=auto"));
});
