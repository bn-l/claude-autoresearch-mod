// The vendored pi helpers agree with pi's own packages as upstream's tests install them
// (upstream/node_modules, from `npm ci` in upstream/).
import assert from "node:assert/strict";
import test from "node:test";

import { truncateToWidth, visibleWidth } from "../plugin/hooks/upstream/vendor/tui-width.ts";
import { formatSize, truncateTail } from "../plugin/hooks/upstream/vendor/truncate.ts";
import { posix } from "../plugin/hooks/upstream/vendor/path.js";
import * as nodePath from "node:path";

const piTui: { visibleWidth(s: string): number; truncateToWidth(s: string, w: number, e?: string, pad?: boolean): string } =
  await import(new URL("../upstream/node_modules/@earendil-works/pi-tui/dist/utils.js", import.meta.url).href);

const SGR = (code: string, text: string) => `\x1b[${code}m${text}\x1b[39m`;

const CORPUS = [
  "",
  "plain ascii",
  "★ total_µs: 15,200µs",
  "🔬 autoresearch: speed up the parser",
  "emoji 👍🏽 and flags 🇯🇵 and zwj 👨‍👩‍👧",
  "CJK 漢字かなカナ한글 mixed",
  "tabs\tand\ttabs",
  SGR("38;2;1;2;3", "styled ") + "\x1b[1mbold\x1b[22m" + SGR("38;2;1;2;4", " ✓ ok"),
  "  " + SGR("38;2;1;2;5", "─".repeat(90)),
  "é combining and ​zero width",
];

test("visibleWidth matches pi-tui", () => {
  for (const text of CORPUS) {
    assert.equal(visibleWidth(text), piTui.visibleWidth(text), JSON.stringify(text));
  }
});

test("truncateToWidth matches pi-tui across widths, ellipses and padding", () => {
  for (const text of CORPUS) {
    for (const width of [0, 1, 3, 5, 8, 13, 21, 40, 120]) {
      for (const ellipsis of ["...", "…"]) {
        for (const pad of [false, true]) {
          assert.equal(
            truncateToWidth(text, width, ellipsis, pad),
            piTui.truncateToWidth(text, width, ellipsis, pad),
            `${JSON.stringify(text)} @${width} ${ellipsis} pad=${pad}`,
          );
        }
      }
    }
  }
});

test("truncateTail keeps the last lines within both limits", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const byLines = truncateTail(lines.join("\n"), { maxLines: 10, maxBytes: 4096 });
  assert.equal(byLines.truncated, true);
  assert.equal(byLines.truncatedBy, "lines");
  assert.equal(byLines.outputLines, 10);
  assert.equal(byLines.totalLines, 30);
  assert.equal(byLines.content.split("\n")[0], "line 21");

  const wide = "x".repeat(3000) + "\n" + "y".repeat(3000);
  const byBytes = truncateTail(wide, { maxLines: 10, maxBytes: 4096 });
  assert.equal(byBytes.truncatedBy, "bytes");
  assert.equal(byBytes.content, "y".repeat(3000));

  const multibyte = "µ".repeat(5000);
  const partial = truncateTail(multibyte, { maxLines: 10, maxBytes: 4097 });
  assert.equal(partial.lastLinePartial, true);
  assert.ok(!partial.content.includes("�"));
  assert.equal(formatSize(4096), "4.0KB");
});

test("posix path matches node:path.posix", () => {
  const cases: [string, string[]][] = [
    ["join", ["/a", ".auto", "log.jsonl"]],
    ["join", ["/a/", "../b", "./c"]],
    ["resolve", ["/repo", "sub/dir"]],
    ["resolve", ["/repo", "/abs"]],
    ["resolve", ["/repo", "../x/./y"]],
    ["relative", ["/a/b", "/a/b/.auto/log.jsonl"]],
    ["relative", ["/a/b", "/a/b"]],
    ["relative", ["/a/b", "/c/d"]],
    ["dirname", ["/a/b/c.txt"]],
    ["basename", ["/a/b/c.txt"]],
    ["extname", ["/a/b/log.jsonl"]],
    ["isAbsolute", ["rel/path"]],
    ["normalize", ["/a//b/../c/."]],
  ];
  for (const [fn, args] of cases) {
    const ours = (posix as unknown as Record<string, (...a: string[]) => unknown>)[fn]!(...args);
    const node = (nodePath.posix as unknown as Record<string, (...a: string[]) => unknown>)[fn]!(...args);
    assert.equal(ours, node, `${fn}(${args.join(", ")})`);
  }
});
