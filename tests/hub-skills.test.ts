import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
// Backups of replaced skills go under the home dir; keep them out of the real one.
process.env.HOME = mkdtempSync(path.join(os.tmpdir(), "hub-skills-home-"));

import { hubGitState, listHubSkills, publishArchive, readHubSkill, removeHubSkill, packHubSkill } from "../hub-skills.ts";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
}

function setup(): { root: string; remote: string } {
  const base = mkdtempSync(path.join(os.tmpdir(), "hub-skills-test-"));
  const remote = path.join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", remote]);
  const root = path.join(base, "skills");
  mkdirSync(root);
  git(root, "init", "-q");
  git(root, "remote", "add", "origin", remote);
  mkdirSync(path.join(root, "ru-text"));
  writeFileSync(path.join(root, "ru-text", "SKILL.md"), '---\nname: ru-text\ndescription: "Edit Russian text"\n---\n# ru-text\n');
  writeFileSync(path.join(root, ".gitignore"), "/private-*\n");
  git(root, "add", "-A");
  git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "HEAD");
  return { root, remote };
}

function archiveOf(dir: string, name: string, files: Record<string, string>): string {
  const src = mkdtempSync(path.join(os.tmpdir(), "hub-skills-src-"));
  mkdirSync(path.join(src, name));
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, name, file)), { recursive: true });
    writeFileSync(path.join(src, name, file), text);
  }
  return execFileSync("tar", ["czf", "-", "-C", src, name]).toString("base64");
}

test("publish adds a skill, commits and pushes; history follows", async () => {
  const { root, remote } = setup();
  const archive = archiveOf(root, "seo-agent", {
    "SKILL.md": '---\nname: seo-agent\ndescription: "SEO audits"\n---\n# SEO\n',
    "references/a.md": "ref",
  });
  const result = await publishArchive(root, archive, "test");
  assert.equal(result.ok, true, result.error ?? "");
  assert.equal(result.replaced, false);
  assert.equal(result.commit?.committed, true);
  assert.equal(result.commit?.pushed, true);
  assert.match(execFileSync("git", ["--git-dir", remote, "log", "--format=%s", "-1"], { encoding: "utf8" }), /add seo-agent/u);
  const detail = await readHubSkill(root, "seo-agent");
  assert.equal(detail?.fileList.length, 2);
  assert.equal(detail?.history[0].subject.startsWith("add seo-agent"), true);
  const list = await listHubSkills(root);
  assert.deepEqual(list.map((item) => item.name), ["ru-text", "seo-agent"]);
  assert.deepEqual(list[1].problems, []);
  const state = await hubGitState(root);
  assert.equal(state.isRepo, true);
  assert.equal(state.dirty, 0);
});

test("publish refuses what BB would reject and leaves the hub untouched", async () => {
  const { root } = setup();
  const before = readFileSync(path.join(root, "ru-text", "SKILL.md"), "utf8");
  const broken = archiveOf(root, "ru-text", { "SKILL.md": "---\nname: ru-text\ndescription: Use when: x\n---\n" });
  const result = await publishArchive(root, broken, "test");
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, "frontmatter-yaml");
  assert.equal(readFileSync(path.join(root, "ru-text", "SKILL.md"), "utf8"), before);
});

test("update replaces the folder, remove records a deletion", async () => {
  const { root } = setup();
  const update = archiveOf(root, "ru-text", { "SKILL.md": '---\nname: ru-text\ndescription: "Edit Russian text v2"\n---\n' });
  const result = await publishArchive(root, update, "test");
  assert.equal(result.replaced, true);
  assert.match(git(root, "log", "--format=%s", "-1"), /update ru-text/u);
  const packed = await packHubSkill(root, "ru-text");
  assert.ok(packed.length > 0);
  const removed = await removeHubSkill(root, "ru-text", "test");
  assert.equal(removed.ok, true);
  assert.equal(existsSync(path.join(root, "ru-text")), false);
  assert.match(git(root, "log", "--format=%s", "-1"), /remove ru-text/u);
});

test("ignored skills are published without a commit", async () => {
  const { root } = setup();
  const archive = archiveOf(root, "private-notes", { "SKILL.md": '---\nname: private-notes\ndescription: "x"\n---\n' });
  const result = await publishArchive(root, archive, "test");
  assert.equal(result.ok, true);
  assert.equal(result.commit, null);
  assert.equal(existsSync(path.join(root, "private-notes", "SKILL.md")), true);
});
