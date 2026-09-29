import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { copySkillTree, measureBbTree } from "../skill-tree.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "skill-tree-"));
  const skill = path.join(root, "skill");
  await mkdir(path.join(skill, "tools", "node_modules", "dep"), { recursive: true });
  await mkdir(path.join(skill, "scripts", "__pycache__"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: s\n---\n");
  await writeFile(path.join(skill, "tools", "run.mjs"), "x".repeat(100));
  await writeFile(path.join(skill, "tools", "node_modules", "dep", "index.js"), "y".repeat(5000));
  await writeFile(path.join(skill, "scripts", "__pycache__", "a.pyc"), "z");
  await symlink(path.join(skill, "tools", "run.mjs"), path.join(skill, "run-link.mjs"));
  return root;
}

test("measureBbTree считает всё, как BB: мусор, симлинки, байты", async () => {
  const root = await fixture();
  try {
    const m = await measureBbTree(path.join(root, "skill"));
    assert.equal(m.files, 4);
    assert.ok(m.bytes > 5000);
    assert.deepEqual(m.symlinks, ["run-link.mjs"]);
    assert.deepEqual([...m.junk].sort(), ["scripts/__pycache__", "tools/node_modules"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("copySkillTree отбрасывает мусор и разворачивает симлинки", async () => {
  const root = await fixture();
  try {
    const dest = path.join(root, "copy");
    await copySkillTree(path.join(root, "skill"), dest);
    assert.deepEqual((await readdir(path.join(dest, "tools"))).sort(), ["run.mjs"]);
    assert.deepEqual(await readdir(path.join(dest, "scripts")), []);
    const m = await measureBbTree(dest);
    assert.deepEqual(m.junk, []);
    assert.deepEqual(m.symlinks, []);
    assert.equal(m.files, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
