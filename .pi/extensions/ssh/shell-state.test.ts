import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  appendShellHistory,
  copyShellState,
  cwdFromCatOutput,
  hostShellStateDir,
  normalizeHistoryLine,
  persistCwd,
  persistHistory,
  pullRemoteSidecars,
  readPersistedCwd,
  remoteCopyShellStateScript,
  remoteShellStateDir,
  sanitizeSessionId,
  sessionIdFromSessionFile,
  wrapBashWithSessionCwd,
} from "./shell-state.ts";

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-shell-state-"));
    try {
      await fn(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test("sanitizeSessionId strips path junk and rejects dot segments", () => {
  assert.equal(sanitizeSessionId("abc-123_XYZ.9"), "abc-123_XYZ.9");
  assert.equal(sanitizeSessionId("../evil id"), "..evilid");
  assert.equal(sanitizeSessionId(".."), "unknown");
  assert.equal(sanitizeSessionId("."), "unknown");
  assert.equal(sanitizeSessionId(""), "unknown");
});

test("host and remote dirs use Gondolin layout under .pi/shell-state", () => {
  assert.equal(
    hostShellStateDir("/repo/workspace", "sess-1"),
    path.join("/repo/workspace", ".pi", "shell-state", "sess-1"),
  );
  assert.equal(
    remoteShellStateDir("/workspace", "sess-1"),
    "/workspace/.pi/shell-state/sess-1",
  );
  assert.equal(
    remoteShellStateDir("/workspace", "bad/id"),
    "/workspace/.pi/shell-state/badid",
  );
});

test(
  "appendShellHistory writes Gondolin HISTFILE lines",
  withTempDir((root) => {
    appendShellHistory(root, "s1", "ls -la  \n");
    appendShellHistory(root, "s1", "cd /workspace/src");
    const file = path.join(hostShellStateDir(root, "s1"), "history");
    assert.equal(fs.readFileSync(file, "utf8"), "ls -la\ncd /workspace/src\n");
    assert.equal(normalizeHistoryLine("pwd  \t  "), "pwd");
  }),
);

test(
  "readPersistedCwd and persistCwd round-trip a safe absolute path",
  withTempDir((root) => {
    persistCwd(root, "s1", "/workspace/src");
    assert.equal(readPersistedCwd(root, "s1"), "/workspace/src");
    persistCwd(root, "s1", "/workspace/src/../escape");
    assert.equal(readPersistedCwd(root, "s1"), "/workspace/src");
    persistCwd(root, "s1", "relative");
    assert.equal(readPersistedCwd(root, "s1"), "/workspace/src");
  }),
);

test("cwdFromCatOutput rejects relative, traversal, and newline paths", () => {
  assert.equal(cwdFromCatOutput("/workspace/src\nextra\n"), "/workspace/src");
  assert.equal(cwdFromCatOutput("/workspace/../etc"), undefined);
  assert.equal(cwdFromCatOutput("workspace"), undefined);
  assert.equal(cwdFromCatOutput("/workspace\0x"), undefined);
  assert.equal(cwdFromCatOutput(""), undefined);
});

test(
  "copyShellState copies cwd and history to a forked session",
  withTempDir((root) => {
    persistCwd(root, "parent", "/workspace/app");
    appendShellHistory(root, "parent", "cd app");
    copyShellState(root, "parent", "child");
    assert.equal(readPersistedCwd(root, "child"), "/workspace/app");
    assert.equal(
      fs.readFileSync(path.join(hostShellStateDir(root, "child"), "history"), "utf8"),
      "cd app\n",
    );
    copyShellState(root, "parent", "parent");
    copyShellState(root, "missing", "child2");
    assert.equal(fs.existsSync(hostShellStateDir(root, "child2")), false);
  }),
);

test("remoteCopyShellStateScript copies cwd and history on the remote tree", () => {
  const script = remoteCopyShellStateScript("/workspace", "parent", "child");
  assert.ok(script);
  assert.match(script!, /mkdir -p '\/workspace\/\.pi\/shell-state\/child'/);
  assert.match(
    script!,
    /cp -f '\/workspace\/\.pi\/shell-state\/parent\/cwd' '\/workspace\/\.pi\/shell-state\/child\/cwd'/,
  );
  assert.match(
    script!,
    /cp -f '\/workspace\/\.pi\/shell-state\/parent\/history' '\/workspace\/\.pi\/shell-state\/child\/history'/,
  );
  assert.equal(
    remoteCopyShellStateScript("/workspace", "same", "same"),
    undefined,
  );
});

test(
  "sessionIdFromSessionFile prefers jsonl header id, then filename",
  withTempDir((root) => {
    const withId = path.join(root, "2026-09-17_abcdef.jsonl");
    fs.writeFileSync(
      withId,
      `${JSON.stringify({ type: "session", id: "header-id-1" })}\n{"type":"message"}\n`,
    );
    assert.equal(sessionIdFromSessionFile(withId), "header-id-1");

    const noHeader = path.join(root, "2026-09-17_file-id.jsonl");
    fs.writeFileSync(noHeader, "not-json\n");
    assert.equal(sessionIdFromSessionFile(noHeader), "file-id");

    assert.equal(sessionIdFromSessionFile(undefined), undefined);
  }),
);

test("wrapBashWithSessionCwd appends HISTFILE, reloads history, restores cwd", () => {
  const script = wrapBashWithSessionCwd(
    "cd src && pwd",
    "/workspace",
    "sess-1",
  );
  assert.match(script, /mkdir -p '\/workspace\/\.pi\/shell-state\/sess-1'/);
  assert.match(
    script,
    /printf '%s\\n' 'cd src && pwd' >> '\/workspace\/\.pi\/shell-state\/sess-1\/history'/,
  );
  assert.match(
    script,
    /export HISTFILE='\/workspace\/\.pi\/shell-state\/sess-1\/history'/,
  );
  assert.match(script, /HISTSIZE=5000 HISTFILESIZE=5000/);
  assert.match(
    script,
    /history -r '\/workspace\/\.pi\/shell-state\/sess-1\/history' 2>\/dev\/null \|\| true/,
  );
  assert.match(
    script,
    /IFS= read -r __pi_last < '\/workspace\/\.pi\/shell-state\/sess-1\/cwd'/,
  );
  assert.match(script, /cd -- "\$__pi_last" \|\| true/);
  assert.match(
    script,
    /pwd > '\/workspace\/\.pi\/shell-state\/sess-1\/cwd' 2>\/dev\/null \|\| true/,
  );
  assert.match(script, /trap __pi_save_cwd EXIT/);
  assert.ok(script.endsWith("cd src && pwd"));
  assert.doesNotMatch(script, /set \+o history/);
  const quoted = wrapBashWithSessionCwd("echo it's", "/workspace", "s1");
  assert.match(quoted, /printf '%s\\n' 'echo it'\\''s' >> /);
  assert.doesNotMatch(script, /\bexport -p\b/);
  assert.doesNotMatch(script, /\bdeclare -x\b/);
  assert.doesNotMatch(script, /\benv\b/);
  assert.doesNotMatch(script, /^\s*set\s*$/m);
  assert.doesNotMatch(script, /^\s*set\s+[^-]/m);
});

test(
  "wrapBashWithSessionCwd captured stdout is the command only",
  withTempDir((root) => {
    const script = wrapBashWithSessionCwd("printf 'only\\n'", root, "s1");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        LEAK_MARKER: "test-leak-secret-value",
      },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "only\n");
    assert.doesNotMatch(
      r.stdout,
      /LEAK_MARKER|test-leak-secret-value|AZURE_CLIENT_SECRET|OPTIND=|IFS=/,
    );
    assert.doesNotMatch(r.stderr, /LEAK_MARKER|test-leak-secret-value/);
    assert.equal(
      fs.readFileSync(path.join(hostShellStateDir(root, "s1"), "history"), "utf8"),
      "printf 'only\\n'\n",
    );
    const cwd = fs.readFileSync(
      path.join(hostShellStateDir(root, "s1"), "cwd"),
      "utf8",
    ).trim();
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(root));
  }),
);

test(
  "wrapBashWithSessionCwd restores cd into the next command with no env dump",
  withTempDir((root) => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub);
    const leakEnv = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      LEAK_MARKER: "test-leak-secret-value",
    };
    const first = wrapBashWithSessionCwd("cd sub && pwd", root, "s1");
    const r1 = spawnSync("bash", ["-c", first], {
      encoding: "utf8",
      cwd: root,
      env: leakEnv,
    });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(fs.realpathSync(r1.stdout.trim()), fs.realpathSync(sub));
    assert.doesNotMatch(r1.stdout, /LEAK_MARKER|test-leak-secret-value|OPTIND=/);

    const second = wrapBashWithSessionCwd("pwd", root, "s1");
    const r2 = spawnSync("bash", ["-c", second], {
      encoding: "utf8",
      cwd: os.tmpdir(),
      env: leakEnv,
    });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.realpathSync(r2.stdout.trim()), fs.realpathSync(sub));
    assert.doesNotMatch(r2.stdout, /LEAK_MARKER|test-leak-secret-value|OPTIND=/);
  }),
);

test(
  "wrapBashWithSessionCwd keeps `cd -` on the remote host, not the host PWD",
  withTempDir((root) => {
    const sub = path.join(root, "sub");
    fs.mkdirSync(sub);
    // A host-side OLDPWD must never decide where a remote `cd -` lands.
    const env = {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      PWD: "/home/alice/projects/demo-app",
      OLDPWD: "/home/alice",
    };

    const first = wrapBashWithSessionCwd("cd sub", root, "s1");
    const r1 = spawnSync("bash", ["-c", first], { encoding: "utf8", cwd: root, env });
    assert.equal(r1.status, 0, r1.stderr);

    // Sidecar now holds cwd=sub and oldpwd=root.
    const dir = hostShellStateDir(root, "s1");
    assert.equal(
      fs.realpathSync(fs.readFileSync(path.join(dir, "cwd"), "utf8").trim()),
      fs.realpathSync(sub),
    );
    assert.equal(
      fs.realpathSync(fs.readFileSync(path.join(dir, "oldpwd"), "utf8").trim()),
      fs.realpathSync(root),
    );

    // `cd -` must land on the remote session's previous directory, never the
    // leaked host OLDPWD.
    const second = wrapBashWithSessionCwd("cd - >/dev/null && pwd", root, "s1");
    const r2 = spawnSync("bash", ["-c", second], { encoding: "utf8", cwd: os.tmpdir(), env });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(fs.realpathSync(r2.stdout.trim()), fs.realpathSync(root));
    assert.doesNotMatch(r2.stdout, /alice/);
    assert.doesNotMatch(r2.stderr, /No such file or directory/);
  }),
);

test(
  "wrapBashWithSessionCwd invents no OLDPWD when no oldpwd sidecar exists",
  withTempDir((root) => {
    // sanitizeRemoteEnv (lib.ts) is what keeps host PWD/OLDPWD out of the
    // remote script. The wrapper's own job is to invent nothing when the
    // sidecar does not exist yet.
    const script = wrapBashWithSessionCwd("printf '%s\\n' \"\${OLDPWD-}\"", root, "fresh");
    const r = spawnSync("bash", ["-c", script], {
      encoding: "utf8",
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, "\n");
    // The guard is a `-s` test, so an empty sidecar can never set OLDPWD.
    assert.match(script, /if \[ -s '.*oldpwd' \]; then/);
    const oldpwdFile = path.join(hostShellStateDir(root, "fresh"), "oldpwd");
    assert.equal(fs.readFileSync(oldpwdFile, "utf8"), "\n");
  }),
);

test(
  "pullRemoteSidecars mirrors remote cwd and history onto the host copy",
  withTempDir(async (root) => {
    const remote = new Map<string, string>([
      ["/workspace/.pi/shell-state/s1/cwd", "/workspace/pkg\n"],
      ["/workspace/.pi/shell-state/s1/history", "ls\ncd pkg\n"],
    ]);
    const got = await pullRemoteSidecars(
      root,
      "s1",
      "/workspace",
      async (p) => remote.get(p),
    );
    assert.equal(got.cwd, "/workspace/pkg");
    assert.equal(readPersistedCwd(root, "s1"), "/workspace/pkg");
    assert.equal(
      fs.readFileSync(path.join(hostShellStateDir(root, "s1"), "history"), "utf8"),
      "ls\ncd pkg\n",
    );
  }),
);

test(
  "pullRemoteSidecars skips unsafe cwd and missing files",
  withTempDir(async (root) => {
    persistCwd(root, "s1", "/workspace/keep");
    persistHistory(root, "s1", "old\n");
    const got = await pullRemoteSidecars(
      root,
      "s1",
      "/workspace",
      async (p) => {
        if (p.endsWith("/cwd")) return "../etc\n";
        return undefined;
      },
    );
    assert.equal(got.cwd, undefined);
    assert.equal(readPersistedCwd(root, "s1"), "/workspace/keep");
    assert.equal(
      fs.readFileSync(path.join(hostShellStateDir(root, "s1"), "history"), "utf8"),
      "old\n",
    );
  }),
);
