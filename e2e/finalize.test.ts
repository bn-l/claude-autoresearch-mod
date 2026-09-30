// upstream tests/finalize_test.sh, unchanged, against the plugin's copy of finalize.sh
// (PLAN §7.1): the test finds the script at ../skills/autoresearch-finalize/finalize.sh
// from its own folder, so it runs from a temp layout whose `skills` is plugin/skills.

import assert from "node:assert/strict";
import { promises as fsp } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { test } from "node:test";

import { PLUGIN_ROOT, REPO_ROOT, removeTempDir, sh } from "./node-host.ts";

test("upstream's finalize_test.sh passes against plugin/skills/autoresearch-finalize/finalize.sh", { timeout: 300_000 }, async () => {
  const root = await fsp.realpath(await mkdtemp(nodePath.join(tmpdir(), "ar-e2e-")));
  try {
    await fsp.mkdir(nodePath.join(root, "tests"));
    await fsp.copyFile(nodePath.join(REPO_ROOT, "upstream/tests/finalize_test.sh"), nodePath.join(root, "tests/finalize_test.sh"));
    await fsp.symlink(nodePath.join(PLUGIN_ROOT, "skills"), nodePath.join(root, "skills"));
    const result = await sh(root, ["bash", "tests/finalize_test.sh"]);
    assert.equal(result.code, 0, (result.stdout + result.stderr).slice(-3000));
    assert.match(result.stdout, /pass|PASS|ok|✓/);
  } finally {
    await removeTempDir(root);
  }
});
