import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDocumentEdits,
  compareStrings,
  formatDirChild,
  formatFileMtime,
  formatFileSize,
  formatIndexedFile,
  immediateChildren,
  filesUnderPath,
  rejectOptionalListPath,
  rejectPath,
  shapeHit,
  sliceBrowsePage,
  sliceReadWindow,
  UNINDEXED_SUFFIX,
} from "./contract.ts";

/** Body lines after the progress header and blank separator. */
function bodyLines(text: string): string[] {
  const sep = text.indexOf("\n\n");
  assert.ok(sep >= 0, "expected progress header then blank line then body");
  return text.slice(sep + 2).split("\n");
}

const NESTED_FILES = [
  { size: "4.1 KB", mtime: "Sep 26 18:07", documentPath: "AGENTS.md" },
  { size: "1.1 KB", mtime: "Sep 26 18:07", documentPath: "README.md" },
  {
    size: "1.7 KB",
    mtime: "Sep 26 18:07",
    documentPath: "a-system-overview/certificate-management.md",
  },
  {
    size: "1.3 KB",
    mtime: "Sep 26 18:07",
    documentPath: "a-system-overview/examples/Payment API Platform.md",
  },
  {
    size: "353 B",
    mtime: "Sep 26 18:07",
    documentPath: "a-system-overview/infra-certificate-authority.md",
  },
  { size: "792 B", mtime: "Sep 26 18:07", documentPath: "c-ci-cd/guide/README.md" },
];

test("paths reject .., absolute, and empty; accept relative", () => {
  assert.equal(rejectPath("").ok, false);
  assert.equal(rejectPath("/tmp/a.md").ok, false);
  assert.equal(rejectPath("../a.md").ok, false);
  assert.equal(rejectPath("docs/runbook.md").ok, true);
});

test("optional list path allows empty and rejects .. and absolute", () => {
  assert.equal(rejectOptionalListPath(undefined).ok, true);
  assert.equal(rejectOptionalListPath("").ok, true);
  assert.equal(rejectOptionalListPath("  ").ok, true);
  assert.equal(rejectOptionalListPath("c-ci-cd/guide").ok, true);
  assert.equal(rejectOptionalListPath("/tmp").ok, false);
  assert.equal(rejectOptionalListPath("../x").ok, false);
});

test("immediateChildren at root lists only files and directories one level deep", () => {
  const children = immediateChildren(NESTED_FILES, "");
  assert.deepEqual(
    children.map((child) => formatDirChild(child)),
    ["4.1 KB  Sep 26 18:07  AGENTS.md", "1.1 KB  Sep 26 18:07  README.md", "a-system-overview/", "c-ci-cd/"],
  );
});

test("immediateChildren in a subdirectory does not include deeper files", () => {
  const children = immediateChildren(NESTED_FILES, "a-system-overview");
  assert.deepEqual(
    children.map((child) => formatDirChild(child)),
    [
      "1.7 KB  Sep 26 18:07  a-system-overview/certificate-management.md",
      "a-system-overview/examples/",
      "353 B  Sep 26 18:07  a-system-overview/infra-certificate-authority.md",
    ],
  );
  assert.equal(
    children.some((child) => child.kind === "file" && child.documentPath.includes("Payment")),
    false,
  );
});

test("filesUnderPath keeps nested files for the tree view", () => {
  const under = filesUnderPath(NESTED_FILES, "a-system-overview");
  assert.equal(under.length, 3);
  assert.equal(under.some((file) => file.documentPath.includes("Payment API Platform.md")), true);
  assert.deepEqual(
    filesUnderPath(NESTED_FILES, "").map((file) => file.documentPath),
    NESTED_FILES.map((file) => file.documentPath),
  );
});

test("browse page reports remaining and next-call hint for kbDocList", () => {
  const lines = ["AGENTS.md", "README.md", "a-system-overview/", "c-ci-cd/"];
  const got = sliceBrowsePage(lines, 0, 2, { tool: "kbDocList", collection: "runbooks", path: "" });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.remaining, 2);
  assert.match(got.text, /\(printed entries 0 through 1 of 4, remaining 2\)/);
  assert.match(got.text, /Call kbDocList with collection=runbooks start=2 to load the next page/);
  assert.deepEqual(bodyLines(got.text), ["AGENTS.md", "README.md"]);
});

test("browse page omitted start defaults to 0", () => {
  const lines = ["AGENTS.md", "README.md", "a-system-overview/", "c-ci-cd/"];
  const got = sliceBrowsePage(lines, undefined, 50, {
    tool: "kbDocList",
    collection: "runbooks",
    path: "",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(got.text, /\(printed entries 0 through 3 of 4, remaining 0\)/);
  assert.ok(!got.text.includes("to load the next page"));
});

test("browse page start past the end errors with total count", () => {
  const got = sliceBrowsePage(["a.md"], 5, 50, {
    tool: "kbDocTree",
    collection: "runbooks",
    path: "",
  });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.error, /1 entries/);
});

test("browse page rejects negative start", () => {
  const got = sliceBrowsePage(["a.md"], -1, 50, {
    tool: "kbDocList",
    collection: "runbooks",
    path: "",
  });
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.error, /start must be an integer >= 0/);
});

test("formatIndexedFile keeps size mtime and relative path", () => {
  assert.equal(
    formatIndexedFile({
      size: "1.3 KB",
      mtime: "Sep 26 18:07",
      documentPath: "a-system-overview/examples/Payment API Platform.md",
    }),
    "1.3 KB  Sep 26 18:07  a-system-overview/examples/Payment API Platform.md",
  );
});

test("formatFileSize matches the qmd ls shapes", () => {
  assert.equal(formatFileSize(0), "0 B");
  assert.equal(formatFileSize(353), "353 B");
  assert.equal(formatFileSize(1023), "1023 B");
  assert.equal(formatFileSize(1024), "1.0 KB");
  assert.equal(formatFileSize(1126), "1.1 KB");
  assert.equal(formatFileSize(4198), "4.1 KB");
  assert.equal(formatFileSize(5 * 1024 * 1024), "5.0 MB");
  assert.equal(formatFileSize(Number.NaN), "0 B");
});

test("formatFileMtime prints Mon DD HH:MM in local time", () => {
  assert.equal(formatFileMtime(new Date(2026, 8, 26, 18, 7)), "Sep 26 18:07");
  assert.equal(formatFileMtime(new Date(2026, 0, 6, 9, 5)), "Jan  6 09:05");
  assert.equal(formatFileMtime(new Date(Number.NaN)), "Jan  1 00:00");
});

test("an unindexed entry carries the unindexed suffix and an indexed one does not", () => {
  const file = { size: "300 B", mtime: "Sep 26 18:07", documentPath: "stack/fpm.conf" };
  assert.equal(formatIndexedFile(file), "300 B  Sep 26 18:07  stack/fpm.conf");
  assert.equal(
    formatIndexedFile(file, true),
    `300 B  Sep 26 18:07  stack/fpm.conf${UNINDEXED_SUFFIX}`,
  );
  assert.equal(formatDirChild({ kind: "dir", documentPath: "stack" }, true), "stack/");
  assert.equal(
    formatDirChild({ kind: "file", documentPath: "stack/fpm.conf", size: "300 B", mtime: "Sep 26 18:07" }, true),
    `300 B  Sep 26 18:07  stack/fpm.conf${UNINDEXED_SUFFIX}`,
  );
});

test("immediateChildren adds an empty on-disk directory that holds no listed file", () => {
  const children = immediateChildren(NESTED_FILES, "", ["assets", "a-system-overview"]);
  assert.deepEqual(
    children.map((child) => formatDirChild(child)),
    [
      "4.1 KB  Sep 26 18:07  AGENTS.md",
      "1.1 KB  Sep 26 18:07  README.md",
      "a-system-overview/",
      "assets/",
      "c-ci-cd/",
    ],
  );

  const scoped = immediateChildren(NESTED_FILES, "assets", ["assets/images", "assets/other/deep"]);
  assert.deepEqual(scoped.map((child) => formatDirChild(child)), ["assets/images/"]);
});

test("compareStrings is plain code-unit order", () => {
  assert.equal(compareStrings("a", "b"), -1);
  assert.equal(compareStrings("b", "a"), 1);
  assert.equal(compareStrings("a", "a"), 0);
  assert.deepEqual(["b/a.md", "a.md", "b.md"].sort(compareStrings), ["a.md", "b.md", "b/a.md"]);
});

test("omitted read bounds produce lines 0-199 as N|text", () => {
  const lines = Array.from({ length: 220 }, (_v, index) => `line-${index}`).join("\n");
  const got = sliceReadWindow(lines);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  const out = bodyLines(got.text);
  assert.equal(out.length, 200);
  assert.equal(out[0], "0|line-0");
  assert.equal(out[199], "199|line-199");
});

test("partial window reports remaining lines and how to continue", () => {
  const lines = Array.from({ length: 220 }, (_v, index) => `line-${index}`).join("\n");
  const got = sliceReadWindow(lines, undefined, undefined, {
    collection: "runbooks",
    documentPath: "docs/a.md",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.remaining, 20);
  assert.match(
    got.text,
    /\(printed from line 0 to line 199 of 220, remaining 20 lines\)/,
  );
  assert.match(
    got.text,
    /Call kbDocRead with collection=runbooks documentPath=docs\/a\.md start=200 end=219 to load the next window/,
  );
  assert.equal(bodyLines(got.text)[0], "0|line-0");
});

test("mid-file window reports lines before and remaining", () => {
  const source = Array.from({ length: 60 }, (_v, index) => `L${index}`).join("\n");
  const got = sliceReadWindow(source, 44, 47, {
    collection: "runbooks",
    documentPath: "docs/a.md",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.remaining, 12);
  assert.match(
    got.text,
    /\(printed from line 44 to line 47 of 60, 44 lines before, remaining 12 lines\)/,
  );
  assert.match(
    got.text,
    /Call kbDocRead with collection=runbooks documentPath=docs\/a\.md start=48 end=59 to load the next window/,
  );
});

test("full-file read does not tell the model to continue", () => {
  const source = "a\nb\nc";
  const got = sliceReadWindow(source, 0, 2, {
    collection: "runbooks",
    documentPath: "docs/a.md",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.remaining, 0);
  assert.match(
    got.text,
    /\(printed from line 0 to line 2 of 3, remaining 0 lines\)/,
  );
  assert.ok(!got.text.includes("to load the next window"));
  assert.deepEqual(bodyLines(got.text), ["0|a", "1|b", "2|c"]);
});

test("first two lines of a five-line file use indices 0-1", () => {
  const source = "a\nb\nc\nd\ne";
  const got = sliceReadWindow(source, 0, 1, {
    collection: "runbooks",
    documentPath: "docs/a.md",
  });
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.match(
    got.text,
    /\(printed from line 0 to line 1 of 5, remaining 3 lines\)/,
  );
  assert.match(
    got.text,
    /Call kbDocRead with collection=runbooks documentPath=docs\/a\.md start=2 end=4 to load the next window/,
  );
  assert.deepEqual(bodyLines(got.text), ["0|a", "1|b"]);
});

test("start past the end errors and includes line count", () => {
  const got = sliceReadWindow("a\nb\nc", 5);
  assert.equal(got.ok, false);
  if (got.ok) return;
  assert.match(got.error, /3 lines/);
});

test("negative start or end is an error", () => {
  assert.equal(sliceReadWindow("a\nb", -1).ok, false);
  assert.equal(sliceReadWindow("a\nb", 0, -1).ok, false);
});

test("missing, repeated, empty, overlapping, and identical edits leave text unchanged", () => {
  const source = "alpha\nbeta\nbeta\ngamma";

  const none = applyDocumentEdits(source, [{ oldText: "delta", newText: "xxx" }]);
  assert.equal(none.ok, false);
  if (!none.ok) assert.equal(none.unchangedText, source);

  const many = applyDocumentEdits(source, [{ oldText: "beta", newText: "xxx" }]);
  assert.equal(many.ok, false);
  if (!many.ok) assert.equal(many.unchangedText, source);

  const empty = applyDocumentEdits(source, [{ oldText: "", newText: "xxx" }]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.unchangedText, source);

  const overlap = applyDocumentEdits("alpha beta gamma", [
    { oldText: "alpha beta", newText: "A" },
    { oldText: "beta gamma", newText: "B" },
  ]);
  assert.equal(overlap.ok, false);
  if (!overlap.ok) assert.equal(overlap.unchangedText, "alpha beta gamma");

  const identical = applyDocumentEdits(source, [{ oldText: "alpha", newText: "alpha" }]);
  assert.equal(identical.ok, false);
  if (!identical.ok) assert.equal(identical.unchangedText, source);

  const noEdits = applyDocumentEdits(source, []);
  assert.equal(noEdits.ok, false);
  if (!noEdits.ok) assert.equal(noEdits.unchangedText, source);
});

test("one small replacement and two disjoint replacements return text and the earliest 0-based line", () => {
  const source = "alpha\nbeta\ngamma";
  const one = applyDocumentEdits(source, [{ oldText: "beta", newText: "BETA" }]);
  assert.equal(one.ok, true);
  if (!one.ok) return;
  assert.equal(one.updatedText, "alpha\nBETA\ngamma");
  assert.equal(one.line, 1);

  const two = applyDocumentEdits(source, [
    { oldText: "gamma", newText: "GAMMA" },
    { oldText: "alpha", newText: "ALPHA" },
  ]);
  assert.equal(two.ok, true);
  if (!two.ok) return;
  assert.equal(two.updatedText, "ALPHA\nbeta\nGAMMA");
  assert.equal(two.line, 0);
});

test("a fuzzy match rewrites the touched line and keeps other lines byte-for-byte", () => {
  const source = "alpha  \nhello world  \ngamma";
  const got = applyDocumentEdits(source, [{ oldText: "hello world\n", newText: "hello there\n" }]);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.updatedText, "alpha  \nhello there\ngamma");
  assert.equal(got.line, 1);
});

test("CRLF files keep their line endings around the replacement", () => {
  const source = "alpha\r\nbeta\r\ngamma";
  const got = applyDocumentEdits(source, [{ oldText: "beta", newText: "BETA" }]);
  assert.equal(got.ok, true);
  if (!got.ok) return;
  assert.equal(got.updatedText, "alpha\r\nBETA\r\ngamma");
});

test("hit shaping trims snippet at 2000 chars", () => {
  const got = shapeHit({
    collection: "runbooks",
    documentPath: "docs\\guide.md",
    snippet: "x".repeat(2200),
    line: 7,
    score: 0.9,
    context: "docs",
  });
  assert.equal(got.collection, "runbooks");
  assert.equal(got.documentPath, "docs/guide.md");
  assert.equal(got.snippet.length, 2000);
  assert.equal(got.line, 7);
  assert.equal(got.score, 0.9);
  assert.equal(got.context, "docs");
});
